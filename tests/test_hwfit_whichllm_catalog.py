"""whichllm as an OPTIONAL live source for the HW Fit catalog.

The catalog in `services/hwfit/data/hf_models.json` is frozen in the repo and
ages silently. `services/hwfit/whichllm_catalog.py` can regenerate it from the
whichllm CLI and seals the result with its date/version/command.

Two things these tests protect:

1. **The offline path is untouched.** No whichllm, no cache, no network ->
   `get_models()` returns exactly the bundled catalog it always did.
2. **The mapping is honest.** whichllm's JSON row shape (captured from a real
   `whichllm --json` run, v0.5.16) maps onto the catalog schema without
   inventing fields — notably `context_length`, which whichllm does not
   expose and which we therefore leave absent instead of guessing.
"""

import json

import pytest

from services.hwfit import models as hwfit_models
from services.hwfit import whichllm_catalog as wc


# A verbatim row from `whichllm --json --top 3 --gpu H200` (v0.5.16).
REAL_ROW = {
    "rank": 1,
    "model_id": "deepseek-ai/DeepSeek-V4-Flash",
    "artifact_repo_id": None,
    "artifact_filename": None,
    "parameter_count": 284000000000,
    "published_at": "2026-04-22T06:04:20.000Z",
    "downloads": 1759503,
    "quant_type": "Q3_K_M",
    "file_size_bytes": 124250000000,
    "vram_required_bytes": 127103363328,
    "vram_available_bytes": 149250113536,
    "uses_multi_gpu": False,
    "multi_gpu_effective_vram_bytes": None,
    "estimated_tok_per_sec": 78.71227364185111,
    "speed_confidence": "medium",
    "speed_range_tok_per_sec": [47.2, 125.9],
    "speed_notes": ["Speed is estimated from memory bandwidth…"],
    "quality_score": 98.02,
    "benchmark_status": "direct",
    "benchmark_source": "direct",
    "benchmark_confidence": 1.0,
    "fit_type": "full_gpu",
    "can_run": True,
    "warnings": [],
    "license": "mit",
}


@pytest.fixture(autouse=True)
def _clean_catalog_cache():
    hwfit_models.reset_model_cache()
    yield
    hwfit_models.reset_model_cache()


# ── mapping ──────────────────────────────────────────────────────────────

def test_real_row_maps_into_catalog_schema():
    entry = wc.map_row(REAL_ROW)
    assert entry["name"] == "deepseek-ai/DeepSeek-V4-Flash"
    assert entry["provider"] == "deepseek-ai"
    assert entry["parameters_raw"] == 284000000000
    assert entry["parameter_count"] == "284B"
    assert entry["quantization"] == "Q3_K_M"
    assert entry["release_date"] == "2026-04-22"
    assert entry["hf_downloads"] == 1759503
    assert entry["_source"] == "whichllm"
    # ~118 GiB of weights -> the VRAM hint must be in GB, not raw bytes.
    assert 100 < entry["min_vram_gb"] < 200
    # The evidence whichllm adds over a plain "does it fit" catalog.
    assert entry["whichllm"]["quality_score"] == 98.02
    assert entry["whichllm"]["benchmark_source"] == "direct"


def test_context_length_is_not_invented():
    """whichllm's JSON has no max-context field. Faking one would poison the
    VRAM math in fit.py, which falls back to 4096 when it is absent."""
    assert "context_length" not in wc.map_row(REAL_ROW)


def test_quant_aliases_map_to_hwfit_vocabulary():
    """whichllm emits FP16; the HW Fit quant tables key on F16."""
    row = dict(REAL_ROW, quant_type="FP16")
    assert wc.map_row(row)["quantization"] == "F16"
    assert wc.map_row(dict(REAL_ROW, quant_type="Q4_K_M"))["quantization"] == "Q4_K_M"


def test_rows_without_a_model_id_are_dropped():
    assert wc.map_row({}) is None
    assert wc.map_row({"model_id": ""}) is None
    assert wc.map_row("not a dict") is None


# ── output parsing ───────────────────────────────────────────────────────

def test_parses_json_even_with_rich_escapes_and_leading_blank_line():
    """whichllm prints through `rich`, which emits SGR codes and a leading
    newline even when stdout is a pipe (verified against v0.5.16)."""
    raw = '\n\x1b[1;36m{"models": [], "hardware": {}}\x1b[0m\n'
    assert wc.parse_json_output(raw) == {"models": [], "hardware": {}}


def test_parses_json_with_a_banner_in_front():
    raw = 'Fetching models…\n{"models": [{"model_id": "a/b"}]}\n'
    assert wc.parse_json_output(raw)["models"][0]["model_id"] == "a/b"


def test_empty_or_non_json_output_raises_a_clear_error():
    with pytest.raises(wc.WhichllmError):
        wc.parse_json_output("")
    with pytest.raises(wc.WhichllmError):
        wc.parse_json_output("command not found")


def test_build_command_forces_a_live_fetch_and_a_roomy_gpu():
    cmd = wc.build_command(["whichllm"], top=250, gpu="H200")
    assert cmd[:2] == ["whichllm", "--json"]
    assert "--top" in cmd and "250" in cmd
    assert "--gpu" in cmd and "H200" in cmd
    assert "--refresh" in cmd  # pressing "update" must not re-read a stale cache
    assert "--refresh" not in wc.build_command(["whichllm"], refresh=False)


# ── availability / offline ───────────────────────────────────────────────

def test_probe_reports_unavailable_with_an_install_hint(monkeypatch):
    monkeypatch.setattr(wc, "_candidate_runners", lambda: iter(()))
    info = wc.probe()
    assert info["available"] is False
    assert "whichllm" in info["install_hint"]


def test_missing_cache_yields_no_rows(monkeypatch, tmp_path):
    monkeypatch.setattr(wc, "WHICHLLM_CACHE", tmp_path / "nope.json")
    assert wc.load_cached_whichllm_models() == []
    assert wc.whichllm_catalog_meta() is None


def test_corrupt_cache_does_not_break_the_catalog(monkeypatch, tmp_path):
    bad = tmp_path / "whichllm_models.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(wc, "WHICHLLM_CACHE", bad)
    assert wc.load_cached_whichllm_models() == []


def test_catalog_without_whichllm_is_the_bundled_catalog(monkeypatch):
    """The offline guarantee: no whichllm rows -> the list HW Fit ranks is the
    bundled catalog plus whatever collection feeds were already cached."""
    monkeypatch.setattr(wc, "load_cached_whichllm_models", lambda: [])
    rows = hwfit_models.get_models()
    bundled = json.load(open(hwfit_models.model_catalog_path(), encoding="utf-8"))
    names = {r["name"] for r in rows}
    assert {m["name"] for m in bundled} <= names


# ── merge behavior ───────────────────────────────────────────────────────

def test_whichllm_adds_unknown_models_without_replacing_curated_ones(monkeypatch):
    bundled = json.load(open(hwfit_models.model_catalog_path(), encoding="utf-8"))
    curated = bundled[0]
    fresh_rows = [
        # A model the freeze never heard of.
        wc.map_row(dict(REAL_ROW, model_id="brand-new/Model-9000")),
        # And a freshness overlay for one it already has.
        dict(
            wc.map_row(REAL_ROW),
            name=curated["name"],
            hf_downloads=(curated.get("hf_downloads") or 0) + 10_000_000,
        ),
    ]
    monkeypatch.setattr(wc, "load_cached_whichllm_models", lambda: fresh_rows)
    hwfit_models.reset_model_cache()
    by_name = {m["name"]: m for m in hwfit_models.get_models()}

    assert "brand-new/Model-9000" in by_name
    merged = by_name[curated["name"]]
    # Curated fields survive…
    assert merged.get("use_case") == curated.get("use_case")
    assert merged.get("context_length") == curated.get("context_length")
    # …while the stuff that goes stale is refreshed, with the evidence attached.
    assert merged["hf_downloads"] == (curated.get("hf_downloads") or 0) + 10_000_000
    assert merged["whichllm"]["benchmark_source"] == "direct"


def test_overlay_never_lowers_a_download_count():
    entry = {"name": "a/b", "hf_downloads": 500}
    wc_rows = [{"name": "a/b", "hf_downloads": 3}]
    hwfit_models._apply_whichllm_overlay({"a/b": entry}, wc_rows)
    assert entry["hf_downloads"] == 500


# ── the seal ─────────────────────────────────────────────────────────────

def test_bundled_catalog_is_sealed_with_a_date_and_a_count():
    meta = hwfit_models.bundled_catalog_meta()
    assert meta["offline"] is True
    assert meta["count"] > 0
    assert meta["sealed_at"], "the bundled catalog must state when it was frozen"
    assert meta["sealed_at_derived_from"], "and where that date comes from"
