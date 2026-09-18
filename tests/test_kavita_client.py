"""Tests for the Kavita HTTP client (services/kavita_client.py).

All tests are OFFLINE: httpx is mocked, no real network calls.
Mirrors the test patterns from tests/test_mstodo_sync.py (conftest.py stubs
heavy deps; we patch httpx.Client directly).
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Stub httpx if not installed (conftest may already have stubbed it)
if "httpx" not in sys.modules:
    sys.modules["httpx"] = MagicMock()

from services.kavita_client import (
    KavitaClient,
    KavitaError,
    get_kavita_url,
    get_kavita_api_key,
    DEFAULT_KAVITA_URL,
)


# ─── CONFIG TESTS ─────────────────────────────────────────────────────────────

class TestConfig:
    def test_default_url(self):
        """KAVITA_URL unset → default http://kavita:5000."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("KAVITA_URL", None)
            assert get_kavita_url() == DEFAULT_KAVITA_URL

    def test_env_url(self):
        """KAVITA_URL set → used (trailing slash stripped)."""
        with patch.dict(os.environ, {"KAVITA_URL": "http://kavita.local:5000/"}):
            assert get_kavita_url() == "http://kavita.local:5000"

    def test_api_key_env(self):
        """KAVITA_API_KEY set → returned."""
        with patch.dict(os.environ, {"KAVITA_API_KEY": "secret-key"}):
            assert get_kavita_api_key() == "secret-key"

    def test_api_key_missing(self):
        """KAVITA_API_KEY unset → empty string."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("KAVITA_API_KEY", None)
            assert get_kavita_api_key() == ""


# ─── AUTH TESTS ───────────────────────────────────────────────────────────────

class TestAuthenticate:
    @patch("services.kavita_client.httpx.Client")
    def test_auth_ok(self, mock_client_cls):
        """Valid apiKey → token stored and returned."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"token": "jwt-abc"}
        mock_client.post.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        token = client.authenticate()
        assert token == "jwt-abc"
        assert client._token == "jwt-abc"
        # Verify the endpoint + params
        call = mock_client.post.call_args
        assert "/api/Plugin/authenticate" in call[0][0]
        assert call[1]["params"]["apiKey"] == "key-1"
        assert call[1]["params"]["pluginName"] == "odysseus"

    @patch("services.kavita_client.httpx.Client")
    def test_auth_missing_api_key(self, mock_client_cls):
        """No apiKey → KavitaError with named cause, no HTTP call."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        client = KavitaClient(url="http://kavita:5000", api_key="")
        with pytest.raises(KavitaError) as exc:
            client.authenticate()
        assert exc.value.cause == "missing_api_key"
        mock_client.post.assert_not_called()

    @patch("services.kavita_client.httpx.Client")
    def test_auth_invalid_key_401(self, mock_client_cls):
        """401 → KavitaError 'apiKey inválida'."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_client.post.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="bad")
        with pytest.raises(KavitaError) as exc:
            client.authenticate()
        assert "inválida" in str(exc.value)
        assert exc.value.cause == "http_401"

    @patch("services.kavita_client.httpx.Client")
    def test_auth_unreachable(self, mock_client_cls):
        """Connection error → KavitaError 'Kavita inalcanzable'."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_client.post.side_effect = Exception("connection refused")

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        with pytest.raises(KavitaError) as exc:
            client.authenticate()
        assert "inalcanzable" in str(exc.value)

    @patch("services.kavita_client.httpx.Client")
    def test_auth_bad_json(self, mock_client_cls):
        """200 but non-JSON → KavitaError named cause."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.side_effect = ValueError("not json")
        mock_client.post.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        with pytest.raises(KavitaError) as exc:
            client.authenticate()
        assert exc.value.cause == "bad_json"

    @patch("services.kavita_client.httpx.Client")
    def test_auth_missing_token(self, mock_client_cls):
        """200 JSON but no token field → KavitaError named cause."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"something": "else"}
        mock_client.post.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        with pytest.raises(KavitaError) as exc:
            client.authenticate()
        assert exc.value.cause == "missing_token"


# ─── HEALTH TESTS ─────────────────────────────────────────────────────────────

class TestHealth:
    @patch("services.kavita_client.httpx.Client")
    def test_health_ok(self, mock_client_cls):
        """200 → True."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client.get.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        assert client.health() is True

    @patch("services.kavita_client.httpx.Client")
    def test_health_down(self, mock_client_cls):
        """500 → False (never throws)."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_client.get.return_value = mock_resp

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        assert client.health() is False

    @patch("services.kavita_client.httpx.Client")
    def test_health_unreachable(self, mock_client_cls):
        """Connection error → False (never throws)."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_client.get.side_effect = Exception("refused")

        client = KavitaClient(url="http://kavita:5000", api_key="key-1")
        assert client.health() is False
