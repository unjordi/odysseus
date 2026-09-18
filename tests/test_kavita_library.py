"""Tests for Kavita library operations (services/kavita_library.py).

All tests are OFFLINE: the KavitaClient is mocked (no real network).
Covers: list libraries, list series, read delegated progress, and that
everything is DEFENSIVE (never-throws / degrades with a named cause when
Kavita responds with an error or is unreachable).
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "httpx" not in sys.modules:
    sys.modules["httpx"] = MagicMock()

from services.kavita_client import KavitaError
from services.kavita_library import (
    KavitaLibrary,
    _as_list,
    _first_str,
    _first_int,
)


# ─── HELPER TESTS (defensive coercion) ───────────────────────────────────────

class TestHelpers:
    def test_as_list_passthrough(self):
        assert _as_list([1, 2, 3]) == [1, 2, 3]

    def test_as_list_dict_wrapper(self):
        assert _as_list({"value": ["a", "b"]}) == ["a", "b"]

    def test_as_list_none(self):
        assert _as_list(None) == []

    def test_as_list_scalar(self):
        assert _as_list(42) == []

    def test_first_str_found(self):
        assert _first_str({"name": "x", "title": "y"}, "name", "title") == "x"

    def test_first_str_fallback(self):
        assert _first_str({"title": "y"}, "name", "title") == "y"

    def test_first_str_missing(self):
        assert _first_str({}, "name", "title") is None

    def test_first_int_found(self):
        assert _first_int({"pageNum": 7}, "pageNum") == 7

    def test_first_int_coerce_str(self):
        assert _first_int({"pageNum": "12"}, "pageNum") == 12

    def test_first_int_missing(self):
        assert _first_int({}, "pageNum") is None

    def test_first_int_ignores_bool(self):
        assert _first_int({"pageNum": True}, "pageNum") is None


# ─── LIBRARIES ────────────────────────────────────────────────────────────────

class TestListLibraries:
    def _lib(self, client_mock):
        return KavitaLibrary(client=client_mock)

    def test_list_libraries_ok(self):
        client = MagicMock()
        client.get.return_value = [
            {"id": 1, "name": "Manga"},
            {"id": 2, "name": "Novels"},
        ]
        lib = self._lib(client)
        result = lib.list_libraries()
        assert len(result) == 2
        assert result[0]["name"] == "Manga"
        client.get.assert_called_once_with("/api/Library/libraries")

    def test_list_libraries_dict_wrapper(self):
        """Kavita may wrap the array in a dict → still returns a list."""
        client = MagicMock()
        client.get.return_value = {"libraries": [{"id": 1}]}
        lib = self._lib(client)
        result = lib.list_libraries()
        assert result == [{"id": 1}]

    def test_list_libraries_empty(self):
        client = MagicMock()
        client.get.return_value = []
        lib = self._lib(client)
        assert lib.list_libraries() == []

    def test_list_libraries_error_degrades(self):
        """KavitaError from client → propagates with named cause (no traceback)."""
        client = MagicMock()
        client.get.side_effect = KavitaError("Kavita inalcanzable en http://kavita:5000", cause="unreachable")
        lib = self._lib(client)
        with pytest.raises(KavitaError) as exc:
            lib.list_libraries()
        assert exc.value.cause == "unreachable"


# ─── SERIES ───────────────────────────────────────────────────────────────────

class TestSeries:
    def test_list_series_with_library_filter(self):
        client = MagicMock()
        client.post.return_value = [{"id": 10, "name": "One Piece"}]
        lib = KavitaLibrary(client=client)
        result = lib.list_series(library_id=1)
        assert result == [{"id": 10, "name": "One Piece"}]
        client.post.assert_called_once_with("/api/Series/all-v2", json={"libraryId": 1})

    def test_list_series_no_filter(self):
        client = MagicMock()
        client.post.return_value = [{"id": 10}, {"id": 11}]
        lib = KavitaLibrary(client=client)
        result = lib.list_series()
        assert len(result) == 2
        client.post.assert_called_once_with("/api/Series/all-v2", json={})

    def test_get_series_ok(self):
        client = MagicMock()
        client.get.return_value = {"id": 10, "name": "One Piece"}
        lib = KavitaLibrary(client=client)
        result = lib.get_series(10)
        assert result["id"] == 10
        client.get.assert_called_once_with("/api/Series/10")

    def test_get_series_non_dict_degrades(self):
        """Non-dict response → {} (defensive, no throw)."""
        client = MagicMock()
        client.get.return_value = ["unexpected"]
        lib = KavitaLibrary(client=client)
        assert lib.get_series(10) == {}

    def test_list_volumes(self):
        client = MagicMock()
        client.get.return_value = [{"id": 100, "name": "Vol 1"}]
        lib = KavitaLibrary(client=client)
        result = lib.list_volumes(10)
        assert result == [{"id": 100, "name": "Vol 1"}]
        client.get.assert_called_once_with("/api/Series/volumes", params={"seriesId": 10})

    def test_get_volume(self):
        client = MagicMock()
        client.get.return_value = {"id": 100, "chapters": []}
        lib = KavitaLibrary(client=client)
        result = lib.get_volume(100)
        assert result["id"] == 100
        client.get.assert_called_once_with("/api/Series/volume", params={"volumeId": 100})


# ─── DELEGATED PROGRESS (read-only) ──────────────────────────────────────────

class TestProgress:
    def test_chapter_progress_ok(self):
        client = MagicMock()
        client.get.return_value = {"chapterId": 555, "pageNum": 42}
        lib = KavitaLibrary(client=client)
        result = lib.get_chapter_progress(555)
        assert result["chapterId"] == 555
        assert result["pageNum"] == 42
        client.get.assert_called_once_with("/api/Reader/get-progress", params={"chapterId": 555})

    def test_chapter_progress_field_rename(self):
        """Kavita renames pageNum → page → still extracted (defensive)."""
        client = MagicMock()
        client.get.return_value = {"chapterId": 555, "page": 7}
        lib = KavitaLibrary(client=client)
        result = lib.get_chapter_progress(555)
        assert result["pageNum"] == 7

    def test_chapter_progress_missing_page(self):
        """No page field → pageNum None (defensive, no throw)."""
        client = MagicMock()
        client.get.return_value = {"chapterId": 555}
        lib = KavitaLibrary(client=client)
        result = lib.get_chapter_progress(555)
        assert result["pageNum"] is None

    def test_continue_point_ok(self):
        client = MagicMock()
        client.get.return_value = {"seriesId": 10, "chapterId": 555, "pageNum": 3}
        lib = KavitaLibrary(client=client)
        result = lib.get_continue_point(10)
        assert result["seriesId"] == 10
        assert result["chapterId"] == 555
        assert result["pageNum"] == 3
        client.get.assert_called_once_with("/api/Reader/continue-point", params={"seriesId": 10})

    def test_continue_point_field_rename(self):
        """chapterId renamed → id → still extracted (defensive)."""
        client = MagicMock()
        client.get.return_value = {"seriesId": 10, "id": 999}
        lib = KavitaLibrary(client=client)
        result = lib.get_continue_point(10)
        assert result["chapterId"] == 999

    def test_continue_point_non_dict(self):
        """Non-dict → normalized with None chapterId (defensive)."""
        client = MagicMock()
        client.get.return_value = ["weird"]
        lib = KavitaLibrary(client=client)
        result = lib.get_continue_point(10)
        assert result["chapterId"] is None


# ─── EPUB DOWNLOAD / METADATA ─────────────────────────────────────────────────

class TestDownload:
    def test_download_chapter_bytes(self):
        client = MagicMock()
        client.get_bytes.return_value = b"%PDF-epub-bytes"
        lib = KavitaLibrary(client=client)
        result = lib.download_chapter(555)
        assert result == b"%PDF-epub-bytes"
        client.get_bytes.assert_called_once_with(
            "/api/Download/chapter", params={"chapterId": 555}
        )

    def test_download_chapter_error_degrades(self):
        client = MagicMock()
        client.get_bytes.side_effect = KavitaError(
            "Kavita respondió error 404 en /api/Download/chapter", cause="http_404"
        )
        lib = KavitaLibrary(client=client)
        with pytest.raises(KavitaError) as exc:
            lib.download_chapter(555)
        assert exc.value.cause == "http_404"

    def test_get_book_info_ok(self):
        client = MagicMock()
        client.get.return_value = {"title": "Vol 1", "pages": 200}
        lib = KavitaLibrary(client=client)
        result = lib.get_book_info(555)
        assert result["title"] == "Vol 1"
        client.get.assert_called_once_with("/api/Book/555/book-info")

    def test_get_book_info_non_dict(self):
        client = MagicMock()
        client.get.return_value = ["nope"]
        lib = KavitaLibrary(client=client)
        assert lib.get_book_info(555) == {}


# ─── DEFENSIVENESS: client errors propagate with named cause ─────────────────

class TestDefensive:
    def test_unreachable_propagates_named_cause(self):
        """A transport failure surfaces as KavitaError with a named cause,
        never a raw traceback."""
        client = MagicMock()
        client.get.side_effect = KavitaError(
            "Kavita inalcanzable en http://kavita:5000", cause="unreachable"
        )
        lib = KavitaLibrary(client=client)
        with pytest.raises(KavitaError) as exc:
            lib.list_libraries()
        assert "inalcanzable" in str(exc.value)
        assert exc.value.cause == "unreachable"

    def test_auth_rejected_propagates(self):
        client = MagicMock()
        client.get.side_effect = KavitaError(
            "Kavita rechazó la autenticación (401) en /api/Library/libraries",
            cause="http_401",
        )
        lib = KavitaLibrary(client=client)
        with pytest.raises(KavitaError) as exc:
            lib.list_libraries()
        assert exc.value.cause == "http_401"
