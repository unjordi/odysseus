"""Kavita HTTP client — read-only connector for Odysseus (#31 Biblioteca, Slice 1).

Design (mirrors services/mstodo_auth.py + services/mstodo_sync.py style):
- Config by ENV: KAVITA_URL (default http://kavita:5000) and KAVITA_API_KEY.
- Auth: POST {KAVITA_URL}/api/Plugin/authenticate?apiKey={KAVITA_API_KEY}&pluginName=odysseus
  → {"token": "<JWT>"}. Subsequent calls use `Authorization: Bearer {token}`.
  (Documented alternative: POST /api/Account/login {username,password} → {token,apiKey}.)
- One client instance == one user (its apiKey). The fork's "per-user" hangs off
  the `owner` (auth+2FA already real); we do NOT duplicate reading progress —
  it is DELEGATED to Kavita (see services/kavita_library.py).
- DEFENSIVE / never-throws: every public method degrades to a named cause
  (KavitaError) instead of a raw traceback. Tolerant to field renames: all
  JSON is read with .get() and validated, never assumed.

Kavita is LIVE in prod (GET {KAVITA_URL}/api/health → 200) but its swagger JSON
is DISABLED (linuxserver). We rely on the documented REST endpoints and stay
tolerant to a field changing name. Tests mock the API — no real network.
"""

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Default base URL (overridable via KAVITA_URL)
DEFAULT_KAVITA_URL = "http://kavita:5000"

# Plugin name we present to Kavita on authenticate
PLUGIN_NAME = "odysseus"


class KavitaError(Exception):
    """Named, actionable error for any Kavita failure.

    Never a raw traceback: the message is human-readable and says WHAT went
    wrong and WHERE (url / endpoint), so the caller can surface it directly.
    """

    def __init__(self, message: str, cause: Optional[str] = None):
        self.cause = cause
        super().__init__(message)


def _clean_url(url: str) -> str:
    """Strip a trailing slash so endpoint joins are stable."""
    return (url or "").rstrip("/")


def _setting(key: str) -> str:
    """Read a Kavita setting from data/settings.json (empty on any failure).

    Lazy import + never-throws so this module keeps working (falling back to
    env) even if the settings layer is unavailable at import time.
    """
    try:
        from src.settings import get_setting
        val = get_setting(key, "")
        return val if isinstance(val, str) else ""
    except Exception:
        return ""


def get_kavita_url() -> str:
    """URL de Kavita. La GUI (Ajustes → Biblioteca) GANA sobre el env
    (KAVITA_URL); si ambos están vacíos, cae al default http://kavita:5000."""
    from_settings = _setting("kavita_url").strip()
    if from_settings:
        return _clean_url(from_settings)
    return _clean_url(os.environ.get("KAVITA_URL", DEFAULT_KAVITA_URL))


def get_kavita_api_key() -> str:
    """apiKey de Kavita. La GUI (Ajustes → Biblioteca) GANA sobre el env
    (KAVITA_API_KEY). Puede quedar vacía (→ 503 accionable en las rutas)."""
    from_settings = _setting("kavita_api_key").strip()
    if from_settings:
        return from_settings
    return os.environ.get("KAVITA_API_KEY", "")


class KavitaClient:
    """Thin, defensive HTTP client for the Kavita REST API.

    One instance == one user (its apiKey). All methods are never-throws:
    they raise KavitaError with a named cause on any failure (unreachable,
    bad apiKey, HTTP error, malformed JSON) and return parsed data otherwise.
    """

    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 10.0,
    ):
        self.url = _clean_url(url if url is not None else get_kavita_url())
        self.api_key = api_key if api_key is not None else get_kavita_api_key()
        self.timeout = timeout
        self._token: Optional[str] = None
        self._client = httpx.Client(timeout=timeout)

    # ── lifecycle ──────────────────────────────────────────────────────────

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client. Never throws."""
        try:
            self._client.close()
        except Exception:
            pass

    # ── auth ───────────────────────────────────────────────────────────────

    def authenticate(self) -> str:
        """Authenticate with the apiKey and return the JWT token.

        POST {url}/api/Plugin/authenticate?apiKey={key}&pluginName=odysseus
        → {"token": "<JWT>"}. Raises KavitaError on any failure (named cause).
        """
        if not self.api_key:
            raise KavitaError(
                "Kavita apiKey no configurada (KAVITA_API_KEY vacía)",
                cause="missing_api_key",
            )
        endpoint = f"{self.url}/api/Plugin/authenticate"
        params = {"apiKey": self.api_key, "pluginName": PLUGIN_NAME}
        try:
            resp = self._client.post(endpoint, params=params)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e

        if resp.status_code in (401, 403):
            raise KavitaError("apiKey inválida", cause=f"http_{resp.status_code}")
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en authenticate",
                cause=f"http_{resp.status_code}",
            )

        try:
            data = resp.json()
        except Exception as e:
            raise KavitaError(
                "Respuesta de authenticate no es JSON válido", cause="bad_json"
            ) from e

        token = data.get("token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise KavitaError(
                "Kavita no devolvió un token en authenticate",
                cause="missing_token",
            )
        self._token = token
        return token

    def _ensure_token(self) -> str:
        """Return a valid token, authenticating lazily if needed. Never throws
        except KavitaError (named cause)."""
        if self._token:
            return self._token
        return self.authenticate()

    def _headers(self) -> dict:
        token = self._ensure_token()
        return {"Authorization": f"Bearer {token}"}

    # ── low-level request helpers (defensive) ──────────────────────────────

    def _request_json(self, method: str, path: str, **kwargs) -> Any:
        """Perform a request and parse JSON, degrading to KavitaError on failure.

        `path` is relative to self.url (e.g. "/api/Library/libraries").
        """
        url = f"{self.url}{path}"
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        try:
            resp = self._client.request(method, url, headers=headers, **kwargs)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e

        if resp.status_code in (401, 403):
            # Token may have expired → clear it so the next call re-authenticates.
            self._token = None
            raise KavitaError(
                f"Kavita rechazó la autenticación ({resp.status_code}) en {path}",
                cause=f"http_{resp.status_code}",
            )
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en {path}",
                cause=f"http_{resp.status_code}",
            )

        try:
            return resp.json()
        except Exception as e:
            raise KavitaError(
                f"Respuesta de {path} no es JSON válido: {e}", cause="bad_json"
            ) from e

    def _request_bytes(self, path: str, **kwargs) -> bytes:
        """Perform a request and return raw bytes (e.g. EPUB download)."""
        url = f"{self.url}{path}"
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        try:
            resp = self._client.request(method="GET", url=url, headers=headers, **kwargs)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e

        if resp.status_code in (401, 403):
            self._token = None
            raise KavitaError(
                f"Kavita rechazó la autenticación ({resp.status_code}) en {path}",
                cause=f"http_{resp.status_code}",
            )
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en {path}",
                cause=f"http_{resp.status_code}",
            )
        return resp.content

    # ── health ─────────────────────────────────────────────────────────────

    def health(self) -> bool:
        """GET {url}/api/health → True if 200, False otherwise. Never throws."""
        try:
            resp = self._client.get(f"{self.url}/api/health")
            return resp.status_code == 200
        except Exception:
            return False

    # ── convenience: raw accessors used by kavita_library ─────────────────

    def get(self, path: str, **kwargs) -> Any:
        """GET a JSON endpoint (defensive)."""
        return self._request_json("GET", path, **kwargs)

    def post(self, path: str, **kwargs) -> Any:
        """POST a JSON endpoint (defensive)."""
        return self._request_json("POST", path, **kwargs)

    def post_ok(self, path: str, **kwargs) -> bool:
        """POST expecting a 2xx with NO meaningful body (e.g. progress write).

        Returns True on success; raises KavitaError (named cause) on failure.
        Deliberately does NOT parse JSON — Kavita's /api/Reader/progress returns
        200 with an empty body, so post() would raise a bogus bad_json.
        """
        url = f"{self.url}{path}"
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        try:
            resp = self._client.request("POST", url, headers=headers, **kwargs)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e
        if resp.status_code in (401, 403):
            self._token = None
            raise KavitaError(
                f"Kavita rechazó la autenticación ({resp.status_code}) en {path}",
                cause=f"http_{resp.status_code}",
            )
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en {path}",
                cause=f"http_{resp.status_code}",
            )
        return True

    def get_bytes(self, path: str, **kwargs) -> bytes:
        """GET a binary endpoint (defensive)."""
        return self._request_bytes(path, **kwargs)

    def get_text(self, path: str, **kwargs) -> str:
        """GET a text endpoint (defensive). Returns the body as a str.

        Used for Kavita's rendered HTML pages (book-page). Raises KavitaError
        (named cause) on transport/auth/HTTP failure.
        """
        url = f"{self.url}{path}"
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        try:
            resp = self._client.request(method="GET", url=url, headers=headers, **kwargs)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e

        if resp.status_code in (401, 403):
            self._token = None
            raise KavitaError(
                f"Kavita rechazó la autenticación ({resp.status_code}) en {path}",
                cause=f"http_{resp.status_code}",
            )
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en {path}",
                cause=f"http_{resp.status_code}",
            )
        return resp.text

    def get_bytes_with_headers(self, path: str, **kwargs) -> tuple[bytes, dict]:
        """GET a binary endpoint and return (bytes, headers) so the caller can
        forward the upstream Content-Type (e.g. book-resources CSS/images).

        Defensive: raises KavitaError (named cause) on transport/auth/HTTP
        failure.
        """
        url = f"{self.url}{path}"
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        try:
            resp = self._client.request(method="GET", url=url, headers=headers, **kwargs)
        except Exception as e:
            raise KavitaError(
                f"Kavita inalcanzable en {self.url}: {e}", cause="unreachable"
            ) from e

        if resp.status_code in (401, 403):
            self._token = None
            raise KavitaError(
                f"Kavita rechazó la autenticación ({resp.status_code}) en {path}",
                cause=f"http_{resp.status_code}",
            )
        if resp.status_code >= 400:
            raise KavitaError(
                f"Kavita respondió error {resp.status_code} en {path}",
                cause=f"http_{resp.status_code}",
            )
        return resp.content, dict(resp.headers)
