"""Execute the terminal broker error/close classification under Node.

Pins hallazgo A-2 (auditoría de coherencia, 2026-09): the terminal WebSocket/SSE
client must distinguish "techo alcanzado" (503 PTY limit / SESSION_LIMIT — fix
by closing a terminal) from "no hay broker / no responde" (fix by checking the
service) and from a WS close by backpressure (code 1013). Before
static/js/term-errors.js existed, terminal.js showed the exact same generic
text for all three.

Driven through `node --input-type=module`, same idiom as
test_chat_stream_errors_js.py — the module has no DOM/WebSocket dependency, so
it runs unmodified under plain Node.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_MODULE = (_REPO / "static" / "js" / "term-errors.js").as_uri()
_HAS_NODE = shutil.which("node") is not None


def _run(body: str) -> str:
    script = f"""
      import {{ classifyTermErrorText, classifyTermCloseEvent }} from {json.dumps(_MODULE)};
      {body}
    """
    proc = subprocess.run(
        ["node", "--input-type=module"],
        input=script, capture_output=True, text=True, encoding="utf-8",
        cwd=str(_REPO), timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


pytestmark = pytest.mark.skipif(not _HAS_NODE, reason="node binary not on PATH")


def test_pty_limit_503_is_distinguished_from_broker_down():
    # Real text axon's http-server.ts sends when term-host-broker.ts rejects the /pty handshake with 503
    # (see term-host-broker.ts handlePtyUpgrade + brokerUnreachableMsg): the PTY-count numbers live only in
    # the HTTP reason phrase, which wsConnect() never captures — "HTTP 503" is the only surviving signal.
    limit_text = (
        "term broker inalcanzable (unix:/home/u/.axon/term-broker.sock): "
        "WS upgrade rechazado: HTTP 503 — ¿está corriendo axon-term-broker.service...?"
    )
    # A genuinely-down broker reaches the same wrapper but with a network error, never "HTTP 503".
    down_text = (
        "term broker inalcanzable (unix:/home/u/.axon/term-broker.sock): "
        "connect ECONNREFUSED — ¿está corriendo axon-term-broker.service...?"
    )
    body = f"""
      const limit = classifyTermErrorText({json.dumps(limit_text)});
      const down = classifyTermErrorText({json.dumps(down_text)});
      console.log(JSON.stringify({{ limitKind: limit.kind, downKind: down.kind, limitMsg: limit.message, downMsg: down.message }}));
    """
    result = json.loads(_run(body))
    assert result["limitKind"] == "limit"
    assert result["downKind"] == "unreachable"
    assert result["limitMsg"] != result["downMsg"]
    # The 503 case must not claim numbers the server never sent to the browser.
    assert "límite" in result["limitMsg"].lower()
    assert "servicio" in result["downMsg"].lower()


def test_session_limit_reuses_the_servers_own_numbers():
    # Real text from term-session.ts ShellSessionPool.run() — piped byte-for-byte to the one-shot SSE error.
    raw = (
        "SESSION_LIMIT: el broker ya tiene 32 sesiones de shell abiertas (tope 32). "
        "Cierra alguna terminal, o sube AXON_TERM_BROKER_MAX_SESSIONS si de verdad necesitas más."
    )
    body = f"""
      const cls = classifyTermErrorText({json.dumps(raw)});
      console.log(JSON.stringify(cls));
    """
    result = json.loads(_run(body))
    assert result["kind"] == "limit"
    # The real numbers the server sent must survive into the message shown to the user.
    assert "32" in result["message"]
    assert "AXON_TERM_BROKER_MAX_SESSIONS" in result["message"]


def test_unrelated_errors_are_not_mislabeled_as_broker_down():
    # A local container-mode PTY spawn failure (pty-session.ts child.on("error", ...)) and a one-shot
    # MISSING_ARG have nothing to do with the broker — must pass through unchanged, not get the
    # "servicio del host no está disponible" framing.
    spawn_err = "spawn script ENOENT"
    missing_arg = "MISSING_ARG: 'cmd' vacío"
    body = f"""
      const a = classifyTermErrorText({json.dumps(spawn_err)});
      const b = classifyTermErrorText({json.dumps(missing_arg)});
      console.log(JSON.stringify({{ aKind: a.kind, aMsg: a.message, bKind: b.kind, bMsg: b.message }}));
    """
    result = json.loads(_run(body))
    assert result == {
        "aKind": "other", "aMsg": spawn_err,
        "bKind": "other", "bMsg": missing_arg,
    }


def test_empty_or_missing_error_text_falls_back_safely():
    body = """
      console.log(JSON.stringify([
        classifyTermErrorText(undefined),
        classifyTermErrorText(''),
        classifyTermErrorText(42),
      ]));
    """
    result = json.loads(_run(body))
    assert all(r == {"kind": "other", "message": "desconocido"} for r in result)


def test_close_1013_is_buffer_pressure_and_keeps_the_servers_reason():
    # Real reason text from ws.ts checkBackpressure(): the byte counts are already in it.
    reason = "cliente no drena: 9000000 B pendientes sobre el techo de 8388608 B"
    body = f"""
      const cls = classifyTermCloseEvent(1013, {json.dumps(reason)});
      console.log(JSON.stringify(cls));
    """
    result = json.loads(_run(body))
    assert result["kind"] == "buffer"
    assert reason in result["message"]


def test_close_1000_is_silent_and_other_codes_keep_code_and_reason():
    body = """
      console.log(JSON.stringify([
        classifyTermCloseEvent(1000, 'pty exit'),
        classifyTermCloseEvent(1011, 'broker unreachable'),
        classifyTermCloseEvent(1006, ''),
      ]));
    """
    normal, other, no_reason = json.loads(_run(body))
    assert normal == {"kind": "normal", "message": ""}
    assert other["kind"] == "generic"
    assert "1011" in other["message"] and "broker unreachable" in other["message"]
    assert no_reason["kind"] == "generic"
    assert "1006" in no_reason["message"]
