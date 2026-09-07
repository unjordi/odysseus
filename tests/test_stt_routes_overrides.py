"""/api/stt/transcribe — the per-request override reaches the service.

Covers the wire contract: the optional form fields are forwarded as options,
and a plain request (no fields) still calls transcribe the old way, so nothing
that already worked changes shape.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.stt_routes import setup_stt_routes


class _StubService:
    def __init__(self):
        self.calls = []
        self.available = True

    def transcribe(self, audio_bytes, options=None):
        self.calls.append((audio_bytes, options))
        return "texto"

    def get_stats(self):
        return {"available": True}


def _client(service):
    app = FastAPI()
    app.include_router(setup_stt_routes(service))
    return TestClient(app)


def test_plain_request_passes_no_options():
    service = _StubService()
    res = _client(service).post("/api/stt/transcribe", files={"file": ("a.webm", b"audio-bytes")})

    assert res.status_code == 200
    assert res.json() == {"text": "texto"}
    assert service.calls == [(b"audio-bytes", None)]


def test_override_fields_are_forwarded():
    service = _StubService()
    res = _client(service).post(
        "/api/stt/transcribe",
        files={"file": ("a.webm", b"audio-bytes")},
        data={"language": "en", "model": "medium", "vad_filter": "false"},
    )

    assert res.status_code == 200
    assert service.calls[0][1] == {"language": "en", "model": "medium", "vad_filter": "false"}


def test_unavailable_service_still_503s():
    service = _StubService()
    service.available = False
    res = _client(service).post("/api/stt/transcribe", files={"file": ("a.webm", b"audio")})
    assert res.status_code == 503
