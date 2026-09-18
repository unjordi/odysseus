"""Tests for routes/kavita_routes.py — Kavita connector MOCKEADO (no red real).

Covers each read-only route (OK) plus the error path (Kavita down → 503 with an
actionable message, never a raw 500). Mirrors the fork's test style.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.kavita_routes import setup_kavita_routes
from services.kavita_client import KavitaError


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(setup_kavita_routes())
    return TestClient(app)


# ── OK paths (connector mocked) ─────────────────────────────────────────────

def test_list_libraries_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def list_libraries(self):
            return [{"id": 1, "name": "Manga"}]

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/libraries")
    assert r.status_code == 200
    assert r.json() == {"libraries": [{"id": 1, "name": "Manga"}]}


def test_list_series_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def list_series(self, library_id=None):
            assert library_id == 7
            return [{"id": 10, "name": "One Piece"}]

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/series", params={"libraryId": 7})
    assert r.status_code == 200
    assert r.json() == {"series": [{"id": 10, "name": "One Piece"}]}


def test_list_volumes_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def list_volumes(self, series_id):
            assert series_id == 42
            return [{"id": 100, "name": "Vol 1"}]

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/series/42/volumes")
    assert r.status_code == 200
    assert r.json() == {"volumes": [{"id": 100, "name": "Vol 1"}]}


def test_get_progress_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_chapter_progress(self, chapter_id):
            assert chapter_id == 999
            return {"chapterId": 999, "pageNum": 12, "raw": {}}

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/progress", params={"chapterId": 999})
    assert r.status_code == 200
    assert r.json()["pageNum"] == 12


def test_get_book_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def download_chapter(self, chapter_id):
            assert chapter_id == 5
            return b"%PDF-epub-bytes"

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/5")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/epub+zip")
    assert r.content == b"%PDF-epub-bytes"


# ── error paths (Kavita down / bad key → clean HTTP, never raw 500) ─────────

def _raise_lib(exc):
    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def list_libraries(self):
            raise exc

        def list_series(self, library_id=None):
            raise exc

        def list_volumes(self, series_id):
            raise exc

        def get_chapter_progress(self, chapter_id):
            raise exc

        def download_chapter(self, chapter_id):
            raise exc

    return FakeLib()


def test_kavita_unreachable_returns_503(client, monkeypatch):
    import routes.kavita_routes as kr
    monkeypatch.setattr(kr, "KavitaLibrary", lambda: _raise_lib(
        KavitaError("Kavita inalcanzable en http://kavita:5000", cause="unreachable")
    ))
    r = client.get("/api/kavita/libraries")
    assert r.status_code == 503
    body = r.json()
    assert "message" in body["detail"]
    assert body["detail"]["cause"] == "unreachable"


def test_missing_api_key_returns_503(client, monkeypatch):
    import routes.kavita_routes as kr
    monkeypatch.setattr(kr, "KavitaLibrary", lambda: _raise_lib(
        KavitaError("Kavita apiKey no configurada", cause="missing_api_key")
    ))
    r = client.get("/api/kavita/series", params={"libraryId": 1})
    assert r.status_code == 503
    assert "KAVITA_API_KEY" in r.json()["detail"]["message"]


def test_bad_api_key_returns_401(client, monkeypatch):
    import routes.kavita_routes as kr
    monkeypatch.setattr(kr, "KavitaLibrary", lambda: _raise_lib(
        KavitaError("Kavita rechazó la autenticación (401)", cause="http_401")
    ))
    r = client.get("/api/kavita/progress", params={"chapterId": 1})
    assert r.status_code == 401
    assert "KAVITA_API_KEY" in r.json()["detail"]["message"]


def test_upstream_error_returns_502(client, monkeypatch):
    import routes.kavita_routes as kr
    monkeypatch.setattr(kr, "KavitaLibrary", lambda: _raise_lib(
        KavitaError("Kavita respondió error 500 en /api/Library/libraries", cause="http_500")
    ))
    r = client.get("/api/kavita/book/1")
    assert r.status_code == 502
    assert "message" in r.json()["detail"]


def test_bad_int_param_returns_400(client, monkeypatch):
    import routes.kavita_routes as kr
    monkeypatch.setattr(kr, "KavitaLibrary", lambda: _raise_lib(KavitaError("x", cause="unreachable")))
    # seriesId is a path int param; FastAPI rejects non-int before our handler.
    r = client.get("/api/kavita/series/notanint/volumes")
    assert r.status_code == 422


# ── DELEGATED RENDERING routes (book-info / toc / page / resource) ──────────

def test_get_book_info_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_info(self, chapter_id):
            assert chapter_id == 555
            return {"bookTitle": "Vol 1", "seriesId": 10, "seriesName": "One Piece"}

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/555/info")
    assert r.status_code == 200
    assert r.json()["info"]["bookTitle"] == "Vol 1"


def test_get_book_toc_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_toc(self, chapter_id):
            assert chapter_id == 777
            return [{"title": "Cap 1", "part": 1, "page": 1, "children": []}]

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/777/toc")
    assert r.status_code == 200
    assert r.json()["toc"][0]["title"] == "Cap 1"


def test_get_book_page_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_page(self, chapter_id, page):
            assert chapter_id == 42
            assert page == 3
            return "<html><body><p>hola</p></body></html>"

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/42/page", params={"page": 3})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "hola" in r.text


def test_get_book_resource_ok(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_resource(self, chapter_id, file):
            assert chapter_id == 9
            assert file == "styles/main.css"
            return (b"body { color: red; }", {"content-type": "text/css"})

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/9/resource", params={"file": "styles/main.css"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")
    assert r.content == b"body { color: red; }"


# ── error paths for the new rendering routes ─────────────────────────────────

def test_book_info_unreachable_returns_503(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_info(self, chapter_id):
            raise KavitaError("Kavita inalcanzable", cause="unreachable")

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/1/info")
    assert r.status_code == 503
    assert r.json()["detail"]["cause"] == "unreachable"


def test_book_page_upstream_error_returns_502(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_page(self, chapter_id, page):
            raise KavitaError("Kavita respondió error 500", cause="http_500")

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/1/page", params={"page": 1})
    assert r.status_code == 502
    assert "message" in r.json()["detail"]


def test_book_resource_bad_key_returns_401(client, monkeypatch):
    import routes.kavita_routes as kr

    class FakeLib:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get_book_resource(self, chapter_id, file):
            raise KavitaError("Kavita rechazó la autenticación (401)", cause="http_401")

    monkeypatch.setattr(kr, "KavitaLibrary", lambda: FakeLib())
    r = client.get("/api/kavita/book/1/resource", params={"file": "x.css"})
    assert r.status_code == 401
    assert "KAVITA_API_KEY" in r.json()["detail"]["message"]
