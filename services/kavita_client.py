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


def get_kavita_url() -> str:
    """Read KAVITA_URL from the environment (default http://kavita:5000)."""
    return _clean_url(os.environ.get("KAVITA_URL", DEFAULT_KAVITA_URL))


def get_kavita_api_key() -> str:
    """Read KAVITA_API_KEY from the environment (may be empty)."""
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

    def get_bytes(self, path: str, **kwargs) -> bytes:
        """GET a binary endpoint (defensive)."""
        return self._request_bytes(path, **kwargs)
