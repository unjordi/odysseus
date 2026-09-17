"""Microsoft OAuth2 (authorization-code flow) for To-Do.

Mirrors the Google OAuth pattern in routes/email_helpers.py:
- make_oauth_state / verify_oauth_state: HMAC-signed state token (CSRF protection).
- build_authorize_url: the /authorize URL the user visits.
- exchange_code: POST /token with the authorization code.
- refresh_token: POST /token with the refresh_token grant.
- Tokens stored encrypted per-user via src/secret_storage (same _enc/_dec pattern as EmailAccount).

Endpoints (Microsoft identity platform v2.0):
- authorize: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
- token:     https://login.microsoftonline.com/common/oauth2/v2.0/token

Scope: Tasks.ReadWrite offline_access
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

# Microsoft identity platform v2.0 endpoints
AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"

# Scope for Microsoft To-Do
MS_TODO_SCOPE = "Tasks.ReadWrite offline_access"


def _load_or_create_key() -> bytes:
    """Load or create the app key for HMAC signing (same as email_helpers)."""
    from src.secret_storage import _load_or_create_key as _lkc
    return _lkc()


def make_oauth_state(account_id: str, owner: str) -> str:
    """Return an HMAC-signed, base64-encoded OAuth state token.

    Encodes account_id + owner + a random nonce, signed with the app secret
    so the callback can validate that the flow was initiated by an
    authenticated, owning user (CSRF / state-forgery protection).
    """
    nonce = secrets.token_hex(16)
    payload = json.dumps({"a": account_id, "o": owner, "n": nonce}, separators=(",", ":"))
    sig = hmac.new(_load_or_create_key(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def verify_oauth_state(state: str) -> Optional[dict]:
    """Verify an OAuth state token's HMAC signature.

    Returns the decoded payload dict ({"a", "o", "n"}) on success, or None if
    the token is malformed, tampered, or signed with a different key.
    """
    try:
        decoded = base64.urlsafe_b64decode(state.encode()).decode()
        payload, sig = decoded.rsplit("|", 1)
        expected = hmac.new(_load_or_create_key(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        return json.loads(payload)
    except Exception:
        return None


def build_authorize_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    scope: str = MS_TODO_SCOPE,
) -> str:
    """Build the Microsoft /authorize URL for the user to visit."""
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "response_mode": "query",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def exchange_code(
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> dict:
    """Exchange an authorization code for tokens.

    Returns {"access_token", "refresh_token", "expires_in", ...}.
    Raises httpx.HTTPStatusError on failure.
    """
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "scope": MS_TODO_SCOPE,
    }
    resp = httpx.post(TOKEN_URL, data=data, timeout=10)
    resp.raise_for_status()
    return resp.json()


def refresh_token(
    client_id: str,
    client_secret: str,
    refresh_token_value: str,
) -> dict:
    """Exchange a refresh token for a new access token.

    Returns {"access_token", "refresh_token", "expires_in", ...}.
    Raises httpx.HTTPStatusError on failure.
    """
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token_value,
        "grant_type": "refresh_token",
        "scope": MS_TODO_SCOPE,
    }
    resp = httpx.post(TOKEN_URL, data=data, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _get_ms_env() -> tuple[str, str]:
    """Read Microsoft OAuth client credentials from environment."""
    client_id = os.environ.get("MS_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("MS_OAUTH_CLIENT_SECRET", "")
    return client_id, client_secret


def refresh_ms_token(account_id: str) -> Optional[str]:
    """Exchange the stored refresh token for a new access token and persist it.

    Mirrors _refresh_google_token in email_helpers.py:
    - Reads the encrypted refresh token from the DB row.
    - POSTs to the Microsoft /token endpoint.
    - Stores the new access token (encrypted) + expiry.
    - Returns the new access token, or None on failure.
    """
    from core.database import SessionLocal as _SL, MsTodoAccount as _MTA
    from src.secret_storage import encrypt as _enc, decrypt as _dec

    client_id, client_secret = _get_ms_env()
    if not client_id or not client_secret:
        logger.warning("MS OAuth client credentials not configured")
        return None

    db = _SL()
    try:
        row = db.get(_MTA, account_id)
        if not row or not row.oauth_refresh_token:
            return None
        refresh_token_value = _dec(row.oauth_refresh_token or "")
        if not refresh_token_value:
            return None

        data = {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token_value,
            "grant_type": "refresh_token",
            "scope": MS_TODO_SCOPE,
        }
        resp = httpx.post(TOKEN_URL, data=data, timeout=10)
        resp.raise_for_status()
        token_data = resp.json()

        access_token = token_data["access_token"]
        row.oauth_access_token = _enc(access_token)
        row.oauth_token_expiry = str(int(time.time()) + token_data.get("expires_in", 3600))
        # Microsoft may rotate the refresh token
        if "refresh_token" in token_data:
            row.oauth_refresh_token = _enc(token_data["refresh_token"])
        db.commit()
        return access_token
    except Exception as e:
        logger.warning(f"Microsoft token refresh failed for account {account_id}: {e}")
        return None
    finally:
        db.close()


def get_valid_ms_token(account_id: str) -> Optional[str]:
    """Return a valid Microsoft access token, refreshing if expired or missing.

    Mirrors _get_valid_google_token in email_helpers.py.
    """
    from core.database import SessionLocal as _SL, MsTodoAccount as _MTA
    from src.secret_storage import decrypt as _dec

    db = _SL()
    try:
        row = db.get(_MTA, account_id)
        if not row:
            return None
        access_token = _dec(row.oauth_access_token or "")
        expiry_str = row.oauth_token_expiry or ""
        if access_token and expiry_str:
            try:
                if int(expiry_str) - 60 > time.time():
                    return access_token
            except (ValueError, TypeError):
                pass
        return refresh_ms_token(account_id)
    finally:
        db.close()
