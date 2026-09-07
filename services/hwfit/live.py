"""Live hardware telemetry seam for the Host Stats panel.

``services/hwfit/hardware.py`` detects *capacity* — total VRAM, GPU name, RAM
total, CPU cores — and caches it for 24h, because that is all the Cookbook
ranker needs. A live load meter needs the opposite: instantaneous GPU
utilization, VRAM *used*, temperature, CPU load %, RAM *used*, and which model
is currently resident. This module adds that, reusing the exact ``nvidia-smi``
shell pattern hardware.py already relies on (so there is one way we talk to the
GPU), and degrades cleanly when a source is unavailable — the same "no GPU"
posture hardware.py takes.

It is intentionally LOCAL / in-container only (no SSH remote-host plumbing):
the panel polls the box that serves Odysseus. Deployment note: reading the GPU
requires the container to actually see it (compose ``gpu-nvidia`` +
``NVIDIA_DRIVER_CAPABILITIES=utility``); if it does not, the ``gpu`` section
degrades to an error string and the rest of the snapshot still returns.
"""

import json
import os
import shutil
import subprocess
import time
import urllib.request

from core.platform_compat import NVIDIA_PATH_CANDIDATES
from services.hwfit.hardware import _parse_meminfo

# Live GPU query — index/name so the panel can label each device, plus the
# three live signals a load meter shows.
_GPU_QUERY = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu"


def _to_float(v, default=None):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


def _to_int(v, default=None):
    f = _to_float(v)
    return int(f) if f is not None else default


def _nvidia_smi_cmd():
    """Resolve nvidia-smi the same way hardware.py does: PATH first, then the
    known absolute locations (CUDA bin, WSL). Returns a command list or None."""
    if shutil.which("nvidia-smi"):
        return ["nvidia-smi"]
    for cand in NVIDIA_PATH_CANDIDATES:
        if os.path.exists(cand):
            return [cand]
    return None


def collect_gpus():
    """Return (gpus, error). Mirrors hardware.py's nvidia-smi handling: if the
    binary is missing or the driver can't be reached, report it rather than
    pretending there is no hardware."""
    cmd = _nvidia_smi_cmd()
    if not cmd:
        return [], "nvidia-smi not available"
    try:
        out = subprocess.run(
            cmd + [f"--query-gpu={_GPU_QUERY}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8,
        )
    except Exception as e:  # pragma: no cover - defensive
        return [], f"nvidia-smi failed: {e}"
    if out.returncode != 0:
        msg = (out.stderr or out.stdout or "nvidia-smi error").strip().split("\n")[0]
        return [], msg[:160]

    low = out.stdout.lower()
    if ("nvml" in low or "driver/library version mismatch" in low
            or "failed to initialize" in low or "no devices were found" in low):
        return [], out.stdout.strip().split("\n")[0][:160] or "NVIDIA driver error"

    gpus = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        used_mb = _to_float(parts[3])
        total_mb = _to_float(parts[4])
        gpus.append({
            "index": _to_int(parts[0], 0),
            "name": parts[1] or "GPU",
            "util": _to_float(parts[2]),
            "mem_used_mb": used_mb,
            "mem_total_mb": total_mb,
            "mem_used_gb": round(used_mb / 1024.0, 2) if used_mb is not None else None,
            "mem_total_gb": round(total_mb / 1024.0, 2) if total_mb is not None else None,
            "mem_percent": (
                round(used_mb / total_mb * 100.0, 1)
                if used_mb is not None and total_mb else None
            ),
            "temp_c": _to_float(parts[5]),
        })
    return gpus, None


def _read_cpu_times():
    """(total, idle) jiffies from /proc/stat's aggregate 'cpu' line."""
    try:
        with open("/proc/stat", "r") as fh:
            for line in fh:
                if line.startswith("cpu "):
                    vals = [int(x) for x in line.split()[1:]]
                    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle+iowait
                    return (sum(vals), idle)
    except OSError:
        return None
    return None


def collect_cpu():
    """CPU load % over a short sampling window (blocking ~0.12s)."""
    cpu = {"cores": os.cpu_count()}
    try:
        with open("/proc/loadavg", "r") as fh:
            cpu["load1"] = _to_float(fh.read().split()[0])
    except Exception:
        cpu["load1"] = None
    a = _read_cpu_times()
    if a is None:
        cpu["util"] = None
        return cpu, "/proc/stat unavailable"
    time.sleep(0.12)
    b = _read_cpu_times()
    if b is None:
        cpu["util"] = None
        return cpu, "/proc/stat unavailable"
    dt_total = b[0] - a[0]
    dt_idle = b[1] - a[1]
    cpu["util"] = round((1.0 - dt_idle / dt_total) * 100.0, 1) if dt_total > 0 else None
    return cpu, None


def collect_ram():
    """RAM used/total via hwfit's /proc/meminfo parser (reused)."""
    info = _parse_meminfo()  # key -> kB
    total_kb = info.get("MemTotal")
    avail_kb = info.get("MemAvailable")
    if not total_kb:
        return {"total_gb": None, "used_gb": None, "percent": None}, "meminfo unavailable"
    total_gb = total_kb / (1024.0 ** 2)
    used_gb = (total_kb - (avail_kb or 0)) / (1024.0 ** 2)
    return {
        "total_gb": round(total_gb, 1),
        "used_gb": round(used_gb, 1),
        "percent": round(used_gb / total_gb * 100.0, 1) if total_gb else None,
    }, None


def _ollama_base_url():
    """Resolve the Ollama root the same way app.py does, minus any /v1 suffix
    (we need the native /api/ps, not the OpenAI-compat path)."""
    in_docker = os.path.exists("/.dockerenv")
    if not in_docker:
        try:
            with open("/proc/1/cgroup", "r", encoding="utf-8", errors="ignore") as fh:
                cg = fh.read()
            in_docker = any(m in cg for m in ("docker", "containerd", "kubepods"))
        except Exception:
            in_docker = False
    base = (
        os.getenv("OLLAMA_BASE_URL")
        or os.getenv("OLLAMA_URL")
        or ("http://host.docker.internal:11434" if in_docker else "http://127.0.0.1:11434")
    )
    base = base.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return base


def collect_models():
    """Currently-resident model(s) from Ollama /api/ps. Returns (models, error)."""
    url = f"{_ollama_base_url()}/api/ps"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return [], f"ollama unreachable: {e}"
    models = []
    for m in (data.get("models") or []):
        if not isinstance(m, dict):
            continue
        size = _to_float(m.get("size"))
        size_vram = _to_float(m.get("size_vram"))
        processor = None
        if size and size_vram is not None:
            if size_vram >= size:
                processor = "100% GPU"
            elif size_vram <= 0:
                processor = "100% CPU"
            else:
                gpu_pct = round(size_vram / size * 100.0)
                processor = f"{100 - gpu_pct}%/{gpu_pct}% CPU/GPU"
        models.append({
            "name": m.get("name") or m.get("model"),
            "size_gb": round(size / (1024.0 ** 3), 2) if size else None,
            "size_vram_gb": round(size_vram / (1024.0 ** 3), 2) if size_vram else None,
            "processor": processor,
        })
    return models, None


def collect_live():
    """Full live snapshot for the Host Stats panel. Every section degrades
    independently; failures surface under ``errors`` instead of raising."""
    gpus, gpu_err = collect_gpus()
    cpu, cpu_err = collect_cpu()
    ram, ram_err = collect_ram()
    models, ollama_err = collect_models()
    return {
        "ok": True,
        "ts": round(time.time(), 3),
        "host": os.uname().nodename if hasattr(os, "uname") else None,
        "gpus": gpus,
        "cpu": cpu,
        "ram": ram,
        "models": models,
        "errors": {
            "gpu": gpu_err,
            "cpu": cpu_err,
            "ram": ram_err,
            "ollama": ollama_err,
        },
    }
