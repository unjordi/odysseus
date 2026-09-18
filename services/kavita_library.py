"""Kavita library operations — read-only + DELEGATED reading progress (#31 Slice 1).

Design (mirrors services/mstodo_sync.py style):
- Wraps services.kavita_client.KavitaClient (one instance == one user / apiKey).
- READ-ONLY: list libraries, list series, list volumes/chapters, read progress,
  stream/download an EPUB. We do NOT write progress back — it is DELEGATED to
  Kavita (the source of truth). Odysseus only reads it.
- DEFENSIVE / never-throws: every public method degrades to a named cause
  (KavitaError) instead of a raw traceback. Tolerant to field renames: all JSON
  is read with .get() and validated, never assumed (Kavita's swagger is disabled
  in prod, so we cannot rely on exact shapes).

Endpoints (documented REST, not swagger):
- GET  /api/Library/libraries
- POST /api/Series/all-v2            (body: filter by libraryId)
- GET  /api/Series/{seriesId}
- GET  /api/Series/volumes?seriesId=
- GET  /api/Series/volume?volumeId=
- GET  /api/Reader/get-progress?chapterId={id}   → pageNum (DELEGATED progress)
- GET  /api/Reader/continue-point?seriesId={id}  → chapter to continue (DELEGATED)
- GET  /api/Download/chapter?chapterId={id}      → EPUB bytes
- GET  /api/Book/{chapterId}/book-info           → EPUB metadata
"""

import logging
from typing import Any, Optional

from services.kavita_client import KavitaClient, KavitaError

logger = logging.getLogger(__name__)


def _as_list(data: Any) -> list:
    """Coerce a JSON payload to a list, tolerating a dict wrapper or None."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # Kavita sometimes wraps arrays; try common keys, else empty.
        for key in ("value", "items", "libraries", "series", "volumes", "chapters"):
            v = data.get(key)
            if isinstance(v, list):
                return v
        return []
    return []


def _first_str(d: dict, *keys: str) -> Optional[str]:
    """Return the first non-empty string among `keys` in dict `d` (defensive)."""
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _first_int(d: dict, *keys: str) -> Optional[int]:
    """Return the first int (or int-coercible) among `keys` in dict `d`."""
    for k in keys:
        v = d.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            return v
        if isinstance(v, str) and v.strip().lstrip("-").isdigit():
            try:
                return int(v)
            except ValueError:
                continue
    return None


class KavitaLibrary:
    """Read-only operations over a Kavita instance, with delegated progress.

    One instance == one user (the client's apiKey). All methods are
    never-throws: they raise KavitaError with a named cause on failure and
    return parsed, validated data otherwise.
    """

    def __init__(self, client: Optional[KavitaClient] = None):
        self.client = client if client is not None else KavitaClient()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    # ── libraries ──────────────────────────────────────────────────────────

    def list_libraries(self) -> list[dict]:
        """GET /api/Library/libraries → list of library dicts.

        Defensive: returns [] on empty/odd shapes, raises KavitaError (named
        cause) on transport/auth/HTTP/JSON failure.
        """
        data = self.client.get("/api/Library/libraries")
        return _as_list(data)

    # ── series ─────────────────────────────────────────────────────────────

    def list_series(self, library_id: Optional[int] = None) -> list[dict]:
        """List series, optionally filtered by libraryId.

        Uses POST /api/Series/all-v2 with a body filter when library_id is
        given; falls back to GET /api/Library/libraries' series when not.
        Defensive: returns [] on empty/odd shapes.
        """
        if library_id is not None:
            body = {"libraryId": library_id}
            data = self.client.post("/api/Series/all-v2", json=body)
        else:
            # No filter: ask for all series via the same endpoint with empty body.
            data = self.client.post("/api/Series/all-v2", json={})
        return _as_list(data)

    def get_series(self, series_id: int) -> dict:
        """GET /api/Series/{seriesId} → a single series dict.

        Defensive: returns {} if Kavita returns a non-dict (never throws on
        shape, only on transport/auth/HTTP/JSON failure).
        """
        data = self.client.get(f"/api/Series/{series_id}")
        return data if isinstance(data, dict) else {}

    # ── volumes / chapters ─────────────────────────────────────────────────

    def list_volumes(self, series_id: int) -> list[dict]:
        """GET /api/Series/volumes?seriesId={id} → list of volume dicts."""
        data = self.client.get("/api/Series/volumes", params={"seriesId": series_id})
        return _as_list(data)

    def get_volume(self, volume_id: int) -> dict:
        """GET /api/Series/volume?volumeId={id} → a single volume dict."""
        data = self.client.get("/api/Series/volume", params={"volumeId": volume_id})
        return data if isinstance(data, dict) else {}

    # ── DELEGATED reading progress (read-only, source of truth = Kavita) ──

    def get_chapter_progress(self, chapter_id: int) -> dict:
        """GET /api/Reader/get-progress?chapterId={id} → progress for this user.

        Returns a normalized dict: {"chapterId", "pageNum", "raw"}. pageNum is
        the delegated reading position (int or None). Defensive: never throws
        on shape; raises KavitaError (named cause) on transport/auth/HTTP/JSON.
        """
        data = self.client.get("/api/Reader/get-progress", params={"chapterId": chapter_id})
        d = data if isinstance(data, dict) else {}
        page_num = _first_int(d, "pageNum", "page", "currentPage", "page_number")
        return {
            "chapterId": chapter_id,
            "pageNum": page_num,
            "raw": d,
        }

    def get_continue_point(self, series_id: int) -> dict:
        """GET /api/Reader/continue-point?seriesId={id} → where this user is.

        Returns a normalized dict: {"seriesId", "chapterId", "pageNum", "raw"}.
        chapterId is the delegated "continue here" chapter (int or None).
        Defensive: never throws on shape; raises KavitaError on failure.
        """
        data = self.client.get("/api/Reader/continue-point", params={"seriesId": series_id})
        d = data if isinstance(data, dict) else {}
        chapter_id = _first_int(d, "chapterId", "chapter_id", "id")
        page_num = _first_int(d, "pageNum", "page", "currentPage")
        return {
            "seriesId": series_id,
            "chapterId": chapter_id,
            "pageNum": page_num,
            "raw": d,
        }

    # ── EPUB stream / download ─────────────────────────────────────────────

    def download_chapter(self, chapter_id: int) -> bytes:
        """GET /api/Download/chapter?chapterId={id} → EPUB bytes.

        Defensive: raises KavitaError (named cause) on transport/auth/HTTP
        failure; returns raw bytes otherwise.
        """
        return self.client.get_bytes(
            "/api/Download/chapter", params={"chapterId": chapter_id}
        )

    def get_book_info(self, chapter_id: int) -> dict:
        """GET /api/Book/{chapterId}/book-info → EPUB metadata dict.

        Defensive: returns {} on non-dict shape; raises KavitaError on failure.
        """
        data = self.client.get(f"/api/Book/{chapter_id}/book-info")
        return data if isinstance(data, dict) else {}

    def get_book_toc(self, chapter_id: int) -> list:
        """GET /api/Book/{chapterId}/chapters → table of contents (list).

        Each entry is a dict like {title, part, page, children:[...]}. Defensive:
        returns [] on non-list shape; raises KavitaError (named cause) on
        transport/auth/HTTP/JSON failure.
        """
        data = self.client.get(f"/api/Book/{chapter_id}/chapters")
        return _as_list(data)

    def get_book_page(self, chapter_id: int, page: int) -> str:
        """GET /api/Book/{chapterId}/book-page?page={n} → rendered HTML.

        This is the CONTENT rendered by Kavita (the delegated rendering we
        recycle instead of epub.js). Defensive: raises KavitaError (named
        cause) on transport/auth/HTTP failure; returns the HTML string
        otherwise.
        """
        return self.client.get_text(
            f"/api/Book/{chapter_id}/book-page", params={"page": page}
        )

    def get_book_resource(self, chapter_id: int, file: str) -> tuple[bytes, dict]:
        """GET /api/Book/{chapterId}/book-resources?file={path} → (bytes, headers).

        Returns the raw resource bytes (CSS/images referenced by the rendered
        HTML) plus the upstream response headers so the route can forward the
        correct Content-Type. Defensive: raises KavitaError (named cause) on
        transport/auth/HTTP failure.
        """
        return self.client.get_bytes_with_headers(
            f"/api/Book/{chapter_id}/book-resources", params={"file": file}
        )
