"""Regenerate the HW Fit model catalog on demand from `whichllm`.

Why this exists
---------------
`services/hwfit/data/hf_models.json` is a catalog FROZEN in the repo. It ages
silently: a model published after the freeze simply does not exist for the
Cookbook, and nothing on screen says how old the data is. `hf_discovery.py`
adds HuggingFace *collections* on a 24 h TTL, but those are owner-curated
lists, not a ranked view of what is actually good today.

`whichllm` (MIT, https://github.com/Andyyyy64/whichllm, PyPI `whichllm`) is a
CLI that fetches models live from the HuggingFace API, merges public benchmark
leaderboards, and ranks them. It is *not* a library API and *not* an HTTP
service: the supported machine-readable contract is `whichllm --json`, whose
schema is documented in its README. So this module shells out to it and maps
its rows into the HW Fit catalog schema.

Contract of this module
-----------------------
- **Optional.** whichllm is NOT a hard dependency. If it is not installed,
  `probe()` reports that and everything else keeps working.
- **Additive.** The bundled `hf_models.json` stays the offline fallback and
  keeps winning on curated fields. whichllm contributes models the frozen
  catalog never heard of, plus a freshness overlay (downloads, release date,
  benchmark evidence) on the ones it already has.
- **Sealed.** Every regenerated catalog is written with its own envelope:
  when it was generated, by which whichllm version, with which command. The
  UI shows that stamp so nobody has to guess how old the list is.
- **Never automatic.** Refreshing costs network and time (whichllm hits the
  HF API and several leaderboards), so it only happens when someone presses
  the button or runs `scripts/refresh_whichllm_catalog.py`.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from src.constants import DATA_DIR


WHICHLLM_PYPI_URL = "https://pypi.org/project/whichllm/"
WHICHLLM_REPO_URL = "https://github.com/Andyyyy64/whichllm"

HW_FIT_CACHE_DIR = Path(DATA_DIR) / "hwfit"
WHICHLLM_CACHE = HW_FIT_CACHE_DIR / "whichllm_models.json"

# The catalog is meant to be hardware-INDEPENDENT: HW Fit does its own ranking
# against the real box. So we ask whichllm for a broad list under a deliberately
# roomy simulated GPU, otherwise it prunes everything that would not fit the
# machine that happens to be running the refresh.
DEFAULT_SIM_GPU = os.getenv("ODYSSEUS_WHICHLLM_GPU", "H200")
DEFAULT_TOP = int(os.getenv("ODYSSEUS_WHICHLLM_TOP", "400") or 400)
DEFAULT_TIMEOUT = int(os.getenv("ODYSSEUS_WHICHLLM_TIMEOUT", "420") or 420)

_GIB = 1024 ** 3
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# whichllm names a few quant tiers differently from the HW Fit vocabulary in
# services/hwfit/models.py (QUANT_BPP & friends). Anything not listed here is
# passed through untouched and then normalized by `_normalize_model_entry`.
QUANT_ALIASES = {
    "FP16": "F16",
    "FP32": "F32",
    "AWQ": "AWQ-4bit",
    "GPTQ": "GPTQ-Int4",
    "Q4_K_S": "Q4_K_M",
    "Q3_K_S": "Q3_K_M",
    "Q3_K_L": "Q3_K_M",
    "Q5_K_S": "Q5_K_M",
}


class WhichllmError(RuntimeError):
    """whichllm is installed but the run failed (bad exit, timeout, junk JSON)."""


# --------------------------------------------------------------------------
# Runner discovery
# --------------------------------------------------------------------------

def _candidate_runners():
    """Ways to invoke whichllm, best first.

    Odysseus ships in a slim container without whichllm, so "installed as a
    Python package" is only one of several realistic paths. `uvx`/`pipx` let a
    user get the button working without rebuilding the image.
    """
    override = (os.getenv("ODYSSEUS_WHICHLLM_CMD") or "").strip()
    if override:
        try:
            argv = shlex.split(override)
        except ValueError:
            argv = []
        if argv:
            yield argv, "env:ODYSSEUS_WHICHLLM_CMD"

    try:
        import importlib.util

        if importlib.util.find_spec("whichllm") is not None:
            yield [sys.executable, "-m", "whichllm"], "python -m whichllm"
    except Exception:
        pass

    exe = shutil.which("whichllm")
    if exe:
        yield [exe], "whichllm (PATH)"

    uvx = shutil.which("uvx")
    if uvx:
        yield [uvx, "whichllm@latest"], "uvx whichllm@latest"

    uv = shutil.which("uv")
    if uv:
        yield [uv, "tool", "run", "whichllm@latest"], "uv tool run whichllm@latest"

    pipx = shutil.which("pipx")
    if pipx:
        yield [pipx, "run", "whichllm"], "pipx run whichllm"


def _clean_env():
    """whichllm prints through `rich`, which colorizes and soft-wraps EVEN when
    stdout is a pipe (verified: `whichllm --version` emits SGR codes into a
    file). Kill the color and give it a wide console so `--json` comes back as
    one parseable document instead of a wrapped, escape-laden one."""
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    env["COLUMNS"] = "1000"
    env.pop("FORCE_COLOR", None)

    # whichllm escribe SU PROPIO caché bajo XDG_CACHE_HOME (o ~/.cache si no está). En el contenedor eso
    # es `/app/.cache`, un directorio que **Docker crea como root:root** al montar el bind de
    # `/app/.cache/huggingface`: la app corre como uid 1000 y no puede crear nada dentro. Resultado
    # observado en vivo (2026-09-08, QA de unjordi):
    #     whichllm exited 1: Error fetching models: [Errno 13] Permission denied: '/app/.cache/whichllm'
    #
    # Se apunta su caché a un subdirectorio de DATA_DIR, que es el volumen que la app SÍ posee y el mismo
    # sitio donde ya vive el catálogo sellado. Se fija también HOME porque no todas las herramientas
    # respetan XDG_CACHE_HOME, y con HOME apuntando a un dir escribible el fallback `~/.cache` también cae
    # en terreno propio. El directorio se crea aquí: si no existe, whichllm falla igual que antes.
    cache = HW_FIT_CACHE_DIR / "whichllm-cache"
    try:
        cache.mkdir(parents=True, exist_ok=True)
        env["XDG_CACHE_HOME"] = str(cache)
        env["HOME"] = str(cache)
    except OSError:
        # Si ni DATA_DIR es escribible, el problema es otro y más grande: se deja el entorno como venía
        # para que el error que salga sea el REAL y no uno enmascarado por este intento.
        pass
    return env


def _run(argv, timeout):
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_clean_env(),
    )


def strip_ansi(text):
    return _ANSI_RE.sub("", text or "")


def parse_json_output(raw):
    """Pull the JSON document out of whichllm's stdout.

    Defensive on purpose: rich may prepend a blank line, and a future version
    could print a banner before the payload. We strip escapes and take the
    outermost {...} span.
    """
    text = strip_ansi(raw).strip()
    if not text:
        raise WhichllmError("whichllm produced no output")
    try:
        return json.loads(text)
    except ValueError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise WhichllmError("whichllm output was not JSON")
    try:
        return json.loads(text[start:end + 1])
    except ValueError as exc:
        raise WhichllmError(f"could not parse whichllm JSON: {exc}") from exc


def probe(timeout=25):
    """Is whichllm reachable, and which version? Never raises."""
    for argv, label in _candidate_runners():
        try:
            proc = _run(list(argv) + ["--version"], timeout)
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode != 0:
            continue
        version = strip_ansi(proc.stdout).strip().splitlines()
        return {
            "available": True,
            "runner": label,
            "argv": list(argv),
            "version": version[0].strip() if version else "",
            "checked_at": int(time.time()),
        }
    return {
        "available": False,
        "runner": None,
        "argv": None,
        "version": None,
        "checked_at": int(time.time()),
        "install_hint": (
            "Install whichllm to enable catalog refresh: "
            "`pip install whichllm` in the Odysseus environment, or make `uvx` "
            "available and it will run `uvx whichllm@latest` on demand. "
            f"See {WHICHLLM_PYPI_URL}"
        ),
    }


# --------------------------------------------------------------------------
# Row mapping: whichllm JSON -> HW Fit catalog entry
# --------------------------------------------------------------------------

def _format_params(raw):
    try:
        n = int(raw or 0)
    except (TypeError, ValueError):
        return "", 0
    if n <= 0:
        return "", 0
    if n >= 1_000_000_000_000:
        return f"{n / 1_000_000_000_000:.3g}T", n
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.4g}B", n
    if n >= 1_000_000:
        return f"{n / 1_000_000:.4g}M", n
    if n >= 1_000:
        return f"{n / 1_000:.4g}K", n
    return str(n), n


def _release_date(published_at):
    text = (published_at or "").strip()
    if not text:
        return ""
    return text[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", text) else ""


def _gb(value):
    try:
        return round(float(value) / _GIB, 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def map_row(row):
    """One whichllm `models[]` row -> one HW Fit catalog entry.

    Only fields HW Fit actually reads are mapped into top-level keys; the
    whichllm-specific evidence (score, benchmark provenance, speed estimate)
    is kept under `whichllm` so it is auditable without colliding with the
    catalog schema. `context_length` is deliberately absent: whichllm's JSON
    does not expose a model's max context, and inventing one would poison the
    VRAM math (fit.py falls back to 4096 when it is missing).
    """
    if not isinstance(row, dict):
        return None
    model_id = (row.get("model_id") or "").strip()
    if not model_id:
        return None

    params_label, params_raw = _format_params(row.get("parameter_count"))
    quant = (row.get("quant_type") or "").strip().upper()
    quant = QUANT_ALIASES.get(quant, quant)
    weights_gb = _gb(row.get("file_size_bytes"))
    vram_gb = _gb(row.get("vram_required_bytes")) or weights_gb

    entry = {
        "name": model_id,
        "provider": model_id.split("/")[0] if "/" in model_id else "",
        "parameter_count": params_label,
        "parameters_raw": params_raw,
        "min_ram_gb": round(weights_gb + 1.0, 1) if weights_gb else 0.0,
        "recommended_ram_gb": round(weights_gb * 1.4 + 2.0, 1) if weights_gb else 0.0,
        "min_vram_gb": vram_gb,
        "quantization": quant,
        "use_case": "",
        "capabilities": [],
        "pipeline_tag": "text-generation",
        "hf_downloads": row.get("downloads") or 0,
        "hf_likes": 0,
        "release_date": _release_date(row.get("published_at")),
        "license": row.get("license") or "",
        "_discovered": True,
        "_source": "whichllm",
        "whichllm": {
            "rank": row.get("rank"),
            "quality_score": row.get("quality_score"),
            "benchmark_status": row.get("benchmark_status"),
            "benchmark_source": row.get("benchmark_source"),
            "benchmark_confidence": row.get("benchmark_confidence"),
            "estimated_tok_per_sec": row.get("estimated_tok_per_sec"),
            "speed_confidence": row.get("speed_confidence"),
            "fit_type": row.get("fit_type"),
            "artifact_repo_id": row.get("artifact_repo_id"),
            "artifact_filename": row.get("artifact_filename"),
        },
    }
    if row.get("artifact_filename") or (row.get("artifact_repo_id") or "").upper().endswith("GGUF"):
        entry["is_gguf"] = True
    return entry


# --------------------------------------------------------------------------
# Fetch + seal
# --------------------------------------------------------------------------

def build_command(argv, top=DEFAULT_TOP, gpu=DEFAULT_SIM_GPU, profile="", refresh=True):
    cmd = list(argv) + ["--json", "--top", str(int(top))]
    if gpu:
        cmd += ["--gpu", str(gpu)]
    if profile:
        cmd += ["--profile", str(profile)]
    if refresh:
        # Ignore whichllm's own 6 h/24 h caches — pressing "update" must mean
        # "go get today's data", not "re-read what you had".
        cmd.append("--refresh")
    return cmd


def fetch_catalog(top=DEFAULT_TOP, gpu=DEFAULT_SIM_GPU, profile="", refresh=True,
                  timeout=DEFAULT_TIMEOUT):
    """Run whichllm and return the sealed envelope (models included)."""
    info = probe()
    if not info.get("available"):
        raise WhichllmError(info.get("install_hint") or "whichllm is not installed")

    cmd = build_command(info["argv"], top=top, gpu=gpu, profile=profile, refresh=refresh)
    try:
        proc = _run(cmd, timeout)
    except subprocess.TimeoutExpired:
        raise WhichllmError(
            f"whichllm timed out after {timeout}s (it fetches HuggingFace + benchmark "
            "leaderboards; raise ODYSSEUS_WHICHLLM_TIMEOUT or lower --top)"
        )
    except OSError as exc:
        raise WhichllmError(f"could not run whichllm: {exc}") from exc

    if proc.returncode != 0:
        detail = strip_ansi(proc.stderr or proc.stdout).strip().splitlines()
        raise WhichllmError(
            f"whichllm exited {proc.returncode}"
            + (f": {detail[-1][:300]}" if detail else "")
        )

    payload = parse_json_output(proc.stdout)
    rows = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise WhichllmError("whichllm JSON had no `models` array")

    models = []
    seen = set()
    for row in rows:
        entry = map_row(row)
        if entry and entry["name"] not in seen:
            seen.add(entry["name"])
            models.append(entry)

    now = int(time.time())
    return {
        "source": "whichllm",
        "source_url": WHICHLLM_REPO_URL,
        "generated_at": now,
        "generated_at_iso": datetime.fromtimestamp(now, tz=timezone.utc)
                                     .isoformat(timespec="seconds")
                                     .replace("+00:00", "Z"),
        "whichllm_version": info.get("version") or "",
        "runner": info.get("runner") or "",
        "command": cmd,
        "simulated_gpu": gpu,
        "requested_top": int(top),
        "profile": profile or "",
        "count": len(models),
        "models": models,
    }


def _write_cache(envelope):
    WHICHLLM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = WHICHLLM_CACHE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, WHICHLLM_CACHE)


def refresh_whichllm_catalog(top=DEFAULT_TOP, gpu=DEFAULT_SIM_GPU, profile="",
                             refresh=True, timeout=DEFAULT_TIMEOUT):
    """Regenerate and persist. Returns the envelope WITHOUT the model rows."""
    envelope = fetch_catalog(top=top, gpu=gpu, profile=profile, refresh=refresh,
                             timeout=timeout)
    _write_cache(envelope)
    meta = {k: v for k, v in envelope.items() if k != "models"}
    return meta


def _read_cache():
    try:
        with WHICHLLM_CACHE.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_cached_whichllm_models():
    """Rows from the last refresh, or [] when there has never been one.

    This is what keeps the offline path intact: no cache file means HW Fit
    simply uses the bundled catalog, exactly as before this feature existed.
    """
    data = _read_cache()
    if not data:
        return []
    rows = data.get("models")
    return rows if isinstance(rows, list) else []


def whichllm_catalog_meta():
    """The seal of the cached catalog (date, source, version) — no rows."""
    data = _read_cache()
    if not data:
        return None
    return {k: v for k, v in data.items() if k != "models"}


def clear_whichllm_catalog():
    """Drop the regenerated catalog and fall back to the bundled one."""
    try:
        WHICHLLM_CACHE.unlink()
        return True
    except OSError:
        return False
