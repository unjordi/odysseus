# routes/kavita_routes.py
"""Kavita API routes — read-only bridge to the Kavita connector (#31 Slice 2a).

Exposes the Kavita connector (services/kavita_client.py + services/kavita_library.py)
over HTTP so the future front-end reader (Slice 2b) can list libraries/series/
volumes, read DELEGATED reading progress, and stream EPUB bytes.

Design (mirrors routes/prefs_routes.py + routes/tts_routes.py):
- FastAPI APIRouter, prefix /api/kavita, registered via setup_kavita_routes().
- Per-user, authenticated like the rest of the fork (get_current_user).
- Config reuses KAVITA_URL / KAVITA_API_KEY from the connector (env for now;
  per-user apiKey in the GUI is a later slice).
- Errors: a KavitaError is translated to a clean HTTP response with an
  actionable message — NEVER a raw traceback (project norm).
  - unreachable / missing_api_key → 503 (Kavita down / not configured)
  - http_401 / http_403 (bad apiKey) → 401
  - other http_* / bad_json / missing_token → 502 (upstream error)
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from src.auth_helpers import get_current_user
from services.kavita_client import KavitaError
from services.kavita_library import KavitaLibrary

logger = logging.getLogger(__name__)


def _kavita_http_error(err: KavitaError) -> HTTPException:
    """Translate a named KavitaError into a clean, actionable HTTPException.

    Mapping by `cause` (see services/kavita_client.py):
      - missing_api_key, unreachable        → 503 (Kavita down / not configured)
      - http_401, http_403                  → 401 (bad apiKey)
      - anything else (http_*, bad_json, missing_token) → 502 (upstream error)
    """
    cause = err.cause or ""
    message = str(err) or "Error de Kavita desconocido"

    if cause in ("missing_api_key", "unreachable"):
        status = 503
        if cause == "missing_api_key":
            message = (
                "Kavita no está configurada: falta KAVITA_API_KEY. "
                "Configura KAVITA_URL y KAVITA_API_KEY en el entorno."
            )
        else:
            message = (
                "Kavita no está alcanzable. Verifica que KAVITA_URL apunte a un "
                "servidor Kavita activo."
            )
    elif cause in ("http_401", "http_403"):
        status = 401
        message = "Kavita rechazó la autenticación: KAVITA_API_KEY inválida."
    else:
        status = 502
        message = f"Kavita devolvió un error inesperado: {message}"

    return HTTPException(status_code=status, detail={"message": message, "cause": cause})


def _to_int(value, field: str) -> int:
    """Coerce a query/path param to int, raising a clean 400 on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail={"message": f"{field} debe ser un número entero", "field": field},
        )


def setup_kavita_routes():
    """Build the Kavita read-only router. One KavitaLibrary per request (cheap,
    stateless; the connector authenticates lazily and closes on exit)."""
    router = APIRouter(prefix="/api/kavita", tags=["kavita"])

    @router.get("/libraries")
    async def list_libraries(request: Request):
        """List Kavita libraries for the current user."""
        get_current_user(request)
        try:
            with KavitaLibrary() as lib:
                libraries = lib.list_libraries()
        except KavitaError as e:
            raise _kavita_http_error(e)
        return {"libraries": libraries}

    @router.get("/series")
    async def list_series(
        request: Request,
        libraryId: Optional[int] = Query(default=None),
    ):
        """List series, optionally filtered by libraryId."""
        get_current_user(request)
        try:
            with KavitaLibrary() as lib:
                series = lib.list_series(library_id=libraryId)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return {"series": series}

    @router.get("/series/{seriesId}/volumes")
    async def list_volumes(request: Request, seriesId: int):
        """List volumes/chapters for a series."""
        get_current_user(request)
        series_id = _to_int(seriesId, "seriesId")
        try:
            with KavitaLibrary() as lib:
                volumes = lib.list_volumes(series_id)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return {"volumes": volumes}

    @router.get("/progress")
    async def get_progress(
        request: Request,
        chapterId: int = Query(...),
    ):
        """DELEGATED reading progress for a chapter (source of truth = Kavita)."""
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        try:
            with KavitaLibrary() as lib:
                progress = lib.get_chapter_progress(chapter_id)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return progress

    @router.get("/book/{chapterId}")
    async def get_book(request: Request, chapterId: int):
        """Stream the EPUB bytes for a chapter (correct content-type)."""
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        try:
            with KavitaLibrary() as lib:
                epub_bytes = lib.download_chapter(chapter_id)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return Response(
            content=epub_bytes,
            media_type="application/epub+zip",
            headers={
                "Content-Disposition": f'inline; filename="chapter-{chapter_id}.epub"'
            },
        )

    # ── DELEGATED RENDERING (Kavita renders the EPUB; we recycle its HTML) ──

    @router.get("/book/{chapterId}/info")
    async def get_book_info(request: Request, chapterId: int):
        """EPUB metadata as rendered by Kavita (bookTitle, seriesId, ...)."""
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        try:
            with KavitaLibrary() as lib:
                info = lib.get_book_info(chapter_id)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return {"info": info}

    @router.get("/book/{chapterId}/toc")
    async def get_book_toc(request: Request, chapterId: int):
        """Table of contents for a chapter (Kavita's /chapters endpoint)."""
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        try:
            with KavitaLibrary() as lib:
                toc = lib.get_book_toc(chapter_id)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return {"toc": toc}

    @router.get("/book/{chapterId}/page")
    async def get_book_page(
        request: Request,
        chapterId: int,
        page: int = Query(..., description="Page number (1-based)"),
    ):
        """Rendered HTML for a single page (Kavita's book-page endpoint).

        This is the DELEGATED rendering: Kavita converts the EPUB page to HTML
        and we forward it verbatim (text/html). The front-end (Slice 2b) just
        displays it — no epub.js needed.
        """
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        page_num = _to_int(page, "page")
        try:
            with KavitaLibrary() as lib:
                html = lib.get_book_page(chapter_id, page_num)
        except KavitaError as e:
            raise _kavita_http_error(e)
        return Response(content=html, media_type="text/html; charset=utf-8")

    @router.get("/book/{chapterId}/resource")
    async def get_book_resource(
        request: Request,
        chapterId: int,
        file: str = Query(..., description="Resource path (CSS/image) referenced by the HTML"),
    ):
        """A resource (CSS/image) referenced by the rendered HTML.

        Forwards the upstream Content-Type so the browser can load it correctly.
        """
        get_current_user(request)
        chapter_id = _to_int(chapterId, "chapterId")
        try:
            with KavitaLibrary() as lib:
                data, headers = lib.get_book_resource(chapter_id, file)
        except KavitaError as e:
            raise _kavita_http_error(e)
        # Forward the upstream Content-Type (defensive: default to octet-stream).
        upstream_ct = headers.get("content-type") or headers.get("Content-Type")
        media_type = upstream_ct if upstream_ct else "application/octet-stream"
        return Response(content=data, media_type=media_type)

    return router
