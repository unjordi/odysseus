# src/app_helpers.py
import base64
import logging
import os

from fastapi import HTTPException
from fastapi.responses import HTMLResponse
from starlette.requests import Request

from src.constants import (
    DEFAULT_UI_LANGUAGE,
    SUPPORTED_UI_LANGUAGES,
    UI_LANGUAGE_COOKIE,
)

logger = logging.getLogger(__name__)


def resolve_ui_language(request: Request) -> str:
    """Resolve the UI language for an initial page render.

    Reads the odysseus_lang cookie (set client-side when the user picks a
    language) and validates it against the supported set so a stale or crafted
    cookie can never inject an arbitrary value into the served HTML. Falls back
    to DEFAULT_UI_LANGUAGE. This only seeds the first paint (<html lang> and the
    initial catalog choice); the client-side i18n runtime is the source of
    truth afterwards.
    """
    try:
        lang = request.cookies.get(UI_LANGUAGE_COOKIE, "")
    except Exception:
        lang = ""
    if lang in SUPPORTED_UI_LANGUAGES:
        return lang
    return DEFAULT_UI_LANGUAGE

def read_if_exists(path: str) -> str:
    """Read file if it exists, return empty string otherwise."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""

def file_to_data_url(path: str, mime: str) -> str:
    """Convert file to data URL."""
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"

def abs_join(base_dir: str, rel: str) -> str:
    """Join paths and return absolute path."""
    return os.path.abspath(os.path.join(base_dir, rel))

def serve_html_with_nonce(request: Request, file_path: str) -> HTMLResponse:
    """Read an app-bundled HTML page and inject the CSP nonce into inline <script> tags.

    Callers pass fixed, server-owned template paths (index/login/backgrounds),
    never a client-supplied path. So any read failure here — a missing file
    (broken deployment) or a permission/IO error — is a server fault, not a
    client "not found": map all of them to a logged 500 so a missing core
    template surfaces in 5xx alerting instead of hiding behind a 404. If a
    future caller serves a client-influenced path where 404 is correct, branch
    that at the call site rather than defaulting this shared helper to 404.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            html = f.read()
    except OSError:
        logger.exception("Failed to read page %s", file_path)
        raise HTTPException(500, "Internal server error")
    nonce = getattr(request.state, "csp_nonce", "")
    html = html.replace("{{CSP_NONCE}}", nonce)
    # Seed the first paint with the resolved UI language so <html lang> and the
    # i18n bootstrap pick the right catalog before any client script runs. Pages
    # without a {{LANG}} placeholder are unaffected (no-op replace).
    html = html.replace("{{LANG}}", resolve_ui_language(request))
    return HTMLResponse(html)


def inside_base_dir(base_dir: str, path: str) -> bool:
    """Check if path is inside base directory."""
    if not isinstance(base_dir, str) or not isinstance(path, str):
        return False
    base = os.path.realpath(base_dir)
    p = os.path.realpath(path)
    try:
        return os.path.commonpath([base, p]) == base
    except Exception:
        return False
