from types import SimpleNamespace

from tests.helpers.cli_loader import load_script
from tests.helpers.db_stubs import make_core_db_stub


def _load_sessions_cli(monkeypatch):
    make_core_db_stub(
        monkeypatch,
        attributes={"SessionLocal": object, "Session": object},
        install_core_package=True,
    )
    return load_script("odysseus-sessions")


def test_serialize_normalizes_numeric_counters(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    session = SimpleNamespace(
        id="s1",
        name="chat",
        model="m",
        endpoint_url="",
        owner=None,
        folder=None,
        archived=False,
        rag=False,
        is_important=False,
        message_count="12",
        total_input_tokens="bad",
        total_output_tokens=None,
        last_accessed=None,
        created_at=None,
    )

    out = cli._serialize(session)

    assert out["message_count"] == 12
    assert out["total_input_tokens"] == 0
    assert out["total_output_tokens"] == 0


# ---------------------------------------------------------------------------
# `import` subcommand — pure mapping helpers (axon export-opencode -> odysseus)
# ---------------------------------------------------------------------------

def test_message_content_concatenates_text_parts(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    parts = [
        {"type": "step-start"},
        {"type": "text", "text": "primero"},
        {"type": "text", "text": "  "},  # blank text part is skipped
        {"type": "text", "text": "segundo"},
    ]
    assert cli._message_content(parts) == "primero\n\nsegundo"


def test_message_content_appends_tool_synopsis_without_dropping_text(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    parts = [
        {"type": "text", "text": "Leo el archivo."},
        {"type": "tool", "tool": "read",
         "state": {"status": "completed", "input": {"file_path": "/a/b.py"}}},
    ]
    out = cli._message_content(parts)
    assert out.startswith("Leo el archivo.")
    assert "[tool:read file_path='/a/b.py' · completed]" in out


def test_message_content_tool_only_turn_never_blank(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    parts = [{"type": "tool", "tool": "bash", "state": {"status": "error", "input": {"command": "ls"}}}]
    out = cli._message_content(parts)
    assert out == "[tool:bash command='ls' · error]"


def test_message_content_no_parts_falls_back_to_placeholder(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    assert cli._message_content([]) == "(mensaje vacío)"


def test_derive_title_prefers_override(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    assert cli._derive_title({"title": "algo"}, "Mi título") == "Mi título"


def test_derive_title_prefixes_and_truncates(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    title = cli._derive_title({"title": "x" * 300}, None)
    assert title.startswith("[CC] ")
    assert len(title) == cli._IMPORT_TITLE_MAX


def test_derive_title_default_when_missing(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    assert cli._derive_title({}, None) == "[CC] Sesión importada de Claude Code"


def test_epoch_ms_to_iso_roundtrips(monkeypatch):
    cli = _load_sessions_cli(monkeypatch)
    assert cli._epoch_ms_to_iso(1790031310064) == "2026-09-21T22:55:10.064000Z"
    assert cli._epoch_ms_to_iso(None) is None
    assert cli._epoch_ms_to_iso("not-a-number") is None


def test_load_export_rejects_wrong_shape(monkeypatch, tmp_path):
    cli = _load_sessions_cli(monkeypatch)
    bad = tmp_path / "bad.json"
    bad.write_text('{"foo": "bar"}')
    try:
        cli._load_export(str(bad))
        assert False, "expected SystemExit"
    except SystemExit as e:
        assert e.code != 0


def test_load_export_accepts_axon_shape(monkeypatch, tmp_path):
    cli = _load_sessions_cli(monkeypatch)
    good = tmp_path / "good.json"
    good.write_text('{"info": {"id": "ses_x"}, "messages": []}')
    data = cli._load_export(str(good))
    assert data["info"]["id"] == "ses_x"
