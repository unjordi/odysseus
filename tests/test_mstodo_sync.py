"""Tests for Microsoft To-Do sync (services/mstodo_sync.py) and auth (services/mstodo_auth.py).

All tests are OFFLINE: httpx is mocked, no real network calls.
Mirrors the test patterns from the repo (conftest.py stubs heavy deps).
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Stub heavy deps before importing our modules
if "sqlalchemy" not in sys.modules:
    sys.modules["sqlalchemy"] = MagicMock()
    sys.modules["sqlalchemy.orm"] = MagicMock()
    sys.modules["sqlalchemy.ext"] = MagicMock()
    sys.modules["sqlalchemy.ext.declarative"] = MagicMock()

if "core" not in sys.modules:
    sys.modules["core"] = MagicMock()
    sys.modules["core.database"] = MagicMock()

if "src" not in sys.modules:
    sys.modules["src"] = MagicMock()
    sys.modules["src.secret_storage"] = MagicMock()

# Now import our modules
from services.mstodo_sync import (
    GraphTodoTask,
    GraphTodoList,
    RemoteTodo,
    graph_task_to_remote_todo,
    graph_tasks_to_remote_todos,
    todo_item_to_graph_body,
    reconcile,
    MsGraphClient,
)
from services.mstodo_auth import (
    make_oauth_state,
    verify_oauth_state,
    build_authorize_url,
    exchange_code,
    refresh_token,
    MS_TODO_SCOPE,
    AUTHORIZE_URL,
    TOKEN_URL,
)


# ─── MAPPING TESTS (mirrors ms-graph-map.ts test cases) ───────────────────────

class TestGraphTaskToRemoteTodo:
    """Test the Graph todoTask → RemoteTodo mapping."""

    def test_completed_status_maps_to_done(self):
        """Graph status 'completed' → RemoteTodo.status 'done'."""
        task_data = {
            "id": "task-1",
            "title": "Buy milk",
            "status": "completed",
            "lastModifiedDateTime": "2026-09-01T10:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.status == "done"

    def test_not_started_status_maps_to_open(self):
        """Graph status 'notStarted' → RemoteTodo.status 'open'."""
        task_data = {
            "id": "task-2",
            "title": "Write report",
            "status": "notStarted",
            "lastModifiedDateTime": "2026-09-01T11:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.status == "open"

    def test_in_progress_status_maps_to_open(self):
        """Graph status 'inProgress' → RemoteTodo.status 'open' (still open for reconciliation)."""
        task_data = {
            "id": "task-3",
            "title": "In progress task",
            "status": "inProgress",
            "lastModifiedDateTime": "2026-09-01T12:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.status == "open"

    def test_deferred_status_maps_to_open(self):
        """Graph status 'deferred' → RemoteTodo.status 'open'."""
        task_data = {
            "id": "task-4",
            "title": "Deferred task",
            "status": "deferred",
            "lastModifiedDateTime": "2026-09-01T13:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.status == "open"

    def test_due_date_present(self):
        """dueDateTime.dateTime is mapped to RemoteTodo.due."""
        task_data = {
            "id": "task-5",
            "title": "Task with due",
            "status": "notStarted",
            "dueDateTime": {"dateTime": "2026-09-15T00:00:00Z", "timeZone": "UTC"},
            "lastModifiedDateTime": "2026-09-01T14:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.due == "2026-09-15T00:00:00Z"

    def test_due_date_absent(self):
        """No dueDateTime → RemoteTodo.due is None."""
        task_data = {
            "id": "task-6",
            "title": "Task without due",
            "status": "notStarted",
            "lastModifiedDateTime": "2026-09-01T15:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.due is None

    def test_missing_id_returns_none(self):
        """Task without id → returns None (caller skips it)."""
        task_data = {
            "title": "No id task",
            "status": "notStarted",
            "lastModifiedDateTime": "2026-09-01T16:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is None

    def test_missing_last_modified_returns_none(self):
        """Task without lastModifiedDateTime → returns None (reconciliation needs it)."""
        task_data = {
            "id": "task-7",
            "title": "No timestamp task",
            "status": "notStarted",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is None

    def test_empty_title_is_ok(self):
        """Graph allows tasks without title; not a reason to skip the row."""
        task_data = {
            "id": "task-8",
            "title": "",
            "status": "notStarted",
            "lastModifiedDateTime": "2026-09-01T17:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "list-1")
        assert result is not None
        assert result.title == ""

    def test_list_id_is_passed_through(self):
        """The listId is provided by the caller, not from the task data."""
        task_data = {
            "id": "task-9",
            "title": "List id test",
            "status": "notStarted",
            "lastModifiedDateTime": "2026-09-01T18:00:00Z",
        }
        task = GraphTodoTask(task_data)
        result = graph_task_to_remote_todo(task, "my-list-id")
        assert result is not None
        assert result.list_id == "my-list-id"


class TestGraphTasksToRemoteTodos:
    """Test batch mapping (skips unmappable rows, never throws)."""

    def test_mixed_valid_and_invalid(self):
        """A list with valid and invalid tasks → only valid ones are returned."""
        tasks = [
            {"id": "t1", "title": "Valid", "status": "notStarted", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
            {"title": "No id", "status": "notStarted", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
            {"id": "t2", "title": "No timestamp", "status": "notStarted"},
            {"id": "t3", "title": "Valid 2", "status": "completed", "lastModifiedDateTime": "2026-09-02T00:00:00Z"},
        ]
        result = graph_tasks_to_remote_todos(tasks, "list-1")
        assert len(result) == 2
        assert result[0].id == "t1"
        assert result[1].id == "t3"
        assert result[1].status == "done"

    def test_empty_list(self):
        """Empty task list → empty result."""
        result = graph_tasks_to_remote_todos([], "list-1")
        assert result == []


class TestTodoItemToGraphBody:
    """Test local TodoItem → Graph body mapping."""

    def test_done_status_maps_to_completed(self):
        """Local status 'done' → Graph status 'completed'."""
        item = {"id": "t1", "title": "Test", "status": "done", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z"}
        body = todo_item_to_graph_body(item)
        assert body["status"] == "completed"

    def test_open_status_maps_to_not_started(self):
        """Local status 'open' → Graph status 'notStarted'."""
        item = {"id": "t1", "title": "Test", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z"}
        body = todo_item_to_graph_body(item)
        assert body["status"] == "notStarted"

    def test_due_present(self):
        """Local due → Graph dueDateTime with timeZone UTC."""
        item = {"id": "t1", "title": "Test", "status": "open", "listId": "l1", "due": "2026-09-15T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z"}
        body = todo_item_to_graph_body(item)
        assert body["dueDateTime"] == {"dateTime": "2026-09-15T00:00:00Z", "timeZone": "UTC"}

    def test_due_absent(self):
        """No local due → no dueDateTime in body."""
        item = {"id": "t1", "title": "Test", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z"}
        body = todo_item_to_graph_body(item)
        assert "dueDateTime" not in body

    def test_id_not_in_body(self):
        """The id is NOT in the body (URL-provided in PATCH, server-assigned in POST)."""
        item = {"id": "t1", "title": "Test", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z"}
        body = todo_item_to_graph_body(item)
        assert "id" not in body


# ─── RECONCILIATION TESTS (mirrors reconcile.ts test cases) ───────────────────

class TestReconcile:
    """Test the bidirectional reconciliation logic."""

    def test_local_only_push_upsert(self):
        """id only in local (not deleted) → push upsert."""
        local = [{"id": "t1", "title": "Local only", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": False}]
        remote = []
        result = reconcile(local, remote)
        assert len(result["push"]) == 1
        assert result["push"][0]["kind"] == "upsert"
        assert result["push"][0]["item"]["id"] == "t1"
        assert len(result["pull"]) == 0

    def test_local_only_deleted_push_delete(self):
        """id only in local (deleted) → push delete (tombstone propagates)."""
        local = [{"id": "t1", "title": "Deleted local", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": True}]
        remote = []
        result = reconcile(local, remote)
        assert len(result["push"]) == 1
        assert result["push"][0]["kind"] == "delete"
        assert result["push"][0]["id"] == "t1"

    def test_remote_only_pull_upsert(self):
        """id only in remote → pull upsert (creation from remote)."""
        local = []
        remote = [RemoteTodo(id="t1", title="Remote only", status="open", list_id="l1", updated_at="2026-09-01T00:00:00Z")]
        result = reconcile(local, remote)
        assert len(result["pull"]) == 1
        assert result["pull"][0]["kind"] == "upsert"
        assert result["pull"][0]["item"]["id"] == "t1"
        assert result["pull"][0]["item"]["deleted"] is False
        assert len(result["push"]) == 0

    def test_both_local_newer_push(self):
        """Both alive, local updatedAt > remote → push (local wins)."""
        local = [{"id": "t1", "title": "Local newer", "status": "open", "listId": "l1", "updatedAt": "2026-09-02T00:00:00Z", "deleted": False}]
        remote = [RemoteTodo(id="t1", title="Remote older", status="open", list_id="l1", updated_at="2026-09-01T00:00:00Z")]
        result = reconcile(local, remote)
        assert len(result["push"]) == 1
        assert result["push"][0]["kind"] == "upsert"
        assert result["push"][0]["item"]["title"] == "Local newer"
        assert "t1" in result["conflicts"]
        assert len(result["pull"]) == 0

    def test_both_remote_newer_pull(self):
        """Both alive, remote updatedAt > local → pull (remote wins)."""
        local = [{"id": "t1", "title": "Local older", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": False}]
        remote = [RemoteTodo(id="t1", title="Remote newer", status="done", list_id="l1", updated_at="2026-09-02T00:00:00Z")]
        result = reconcile(local, remote)
        assert len(result["pull"]) == 1
        assert result["pull"][0]["kind"] == "upsert"
        assert result["pull"][0]["item"]["title"] == "Remote newer"
        assert result["pull"][0]["item"]["status"] == "done"
        assert "t1" in result["conflicts"]
        assert len(result["push"]) == 0

    def test_both_tie_local_wins(self):
        """Both alive, updatedAt equal → local wins (no op, stability)."""
        local = [{"id": "t1", "title": "Local", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": False}]
        remote = [RemoteTodo(id="t1", title="Remote", status="open", list_id="l1", updated_at="2026-09-01T00:00:00Z")]
        result = reconcile(local, remote)
        assert len(result["push"]) == 0
        assert len(result["pull"]) == 0
        assert len(result["conflicts"]) == 0

    def test_local_deleted_propagates(self):
        """Both alive, local deleted → push delete (delete > edit)."""
        local = [{"id": "t1", "title": "Deleted", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": True}]
        remote = [RemoteTodo(id="t1", title="Remote alive", status="open", list_id="l1", updated_at="2026-09-02T00:00:00Z")]
        result = reconcile(local, remote)
        assert len(result["push"]) == 1
        assert result["push"][0]["kind"] == "delete"
        assert result["push"][0]["id"] == "t1"
        assert len(result["pull"]) == 0

    def test_mixed_scenario(self):
        """Complex scenario: multiple items in different states."""
        local = [
            {"id": "t1", "title": "Local only", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": False},
            {"id": "t2", "title": "Local deleted", "status": "open", "listId": "l1", "updatedAt": "2026-09-01T00:00:00Z", "deleted": True},
            {"id": "t3", "title": "Local newer", "status": "open", "listId": "l1", "updatedAt": "2026-09-03T00:00:00Z", "deleted": False},
        ]
        remote = [
            RemoteTodo(id="t2", title="Remote alive", status="open", list_id="l1", updated_at="2026-09-02T00:00:00Z"),
            RemoteTodo(id="t3", title="Remote older", status="open", list_id="l1", updated_at="2026-09-01T00:00:00Z"),
            RemoteTodo(id="t4", title="Remote only", status="done", list_id="l1", updated_at="2026-09-01T00:00:00Z"),
        ]
        result = reconcile(local, remote)
        # t1: local only → push upsert
        # t2: local deleted → push delete
        # t3: local newer → push upsert
        # t4: remote only → pull upsert
        assert len(result["push"]) == 3
        assert len(result["pull"]) == 1
        push_kinds = {op["id"] if op["kind"] == "delete" else op["item"]["id"]: op["kind"] for op in result["push"]}
        assert push_kinds == {"t1": "upsert", "t2": "delete", "t3": "upsert"}
        assert result["pull"][0]["item"]["id"] == "t4"


# ─── OAUTH TESTS (mirrors email_helpers.py patterns) ──────────────────────────

class TestOAuthState:
    """Test the HMAC-signed OAuth state token."""

    def test_make_and_verify_state(self):
        """make_oauth_state → verify_oauth_state round-trip."""
        state = make_oauth_state("account-1", "owner-1")
        result = verify_oauth_state(state)
        assert result is not None
        assert result["a"] == "account-1"
        assert result["o"] == "owner-1"
        assert "n" in result  # nonce present

    def test_verify_tampered_state(self):
        """Tampered state → verify returns None."""
        state = make_oauth_state("account-1", "owner-1")
        # Tamper with the state
        tampered = state[:-4] + "XXXX"
        result = verify_oauth_state(tampered)
        assert result is None

    def test_verify_malformed_state(self):
        """Malformed state → verify returns None."""
        result = verify_oauth_state("not-a-valid-state")
        assert result is None

    def test_verify_empty_state(self):
        """Empty state → verify returns None."""
        result = verify_oauth_state("")
        assert result is None


class TestBuildAuthorizeUrl:
    """Test the /authorize URL construction."""

    def test_url_contains_required_params(self):
        """The authorize URL contains client_id, redirect_uri, scope, state."""
        url = build_authorize_url(
            client_id="my-client-id",
            redirect_uri="https://example.com/callback",
            state="test-state",
        )
        assert url.startswith(AUTHORIZE_URL)
        assert "client_id=my-client-id" in url
        assert "redirect_uri=" in url
        assert "scope=" in url
        assert "state=test-state" in url
        assert "response_type=code" in url

    def test_scope_is_tasks_readwrite(self):
        """The scope is Tasks.ReadWrite offline_access."""
        url = build_authorize_url(
            client_id="my-client-id",
            redirect_uri="https://example.com/callback",
            state="test-state",
        )
        assert "Tasks.ReadWrite" in url
        assert "offline_access" in url


class TestExchangeCode:
    """Test the authorization code exchange (mocked)."""

    @patch("services.mstodo_auth.httpx.post")
    def test_exchange_code_success(self, mock_post):
        """Successful code exchange returns tokens."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "access_token": "new-access-token",
            "refresh_token": "new-refresh-token",
            "expires_in": 3600,
            "token_type": "Bearer",
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = exchange_code(
            client_id="my-client-id",
            client_secret="my-secret",
            code="auth-code-123",
            redirect_uri="https://example.com/callback",
        )

        assert result["access_token"] == "new-access-token"
        assert result["refresh_token"] == "new-refresh-token"
        assert result["expires_in"] == 3600

        # Verify the POST was called with the right data
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["data"]["grant_type"] == "authorization_code"
        assert call_kwargs[1]["data"]["code"] == "auth-code-123"

    @patch("services.mstodo_auth.httpx.post")
    def test_exchange_code_failure(self, mock_post):
        """Failed code exchange raises HTTPStatusError."""
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.raise_for_status.side_effect = Exception("Bad request")
        mock_post.return_value = mock_response

        with pytest.raises(Exception):
            exchange_code(
                client_id="my-client-id",
                client_secret="my-secret",
                code="bad-code",
                redirect_uri="https://example.com/callback",
            )


class TestRefreshToken:
    """Test the refresh token flow (mocked)."""

    @patch("services.mstodo_auth.httpx.post")
    def test_refresh_token_success(self, mock_post):
        """Successful refresh returns new access token."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "access_token": "refreshed-access-token",
            "refresh_token": "rotated-refresh-token",
            "expires_in": 3600,
            "token_type": "Bearer",
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = refresh_token(
            client_id="my-client-id",
            client_secret="my-secret",
            refresh_token_value="old-refresh-token",
        )

        assert result["access_token"] == "refreshed-access-token"
        assert result["refresh_token"] == "rotated-refresh-token"

        # Verify the POST was called with the right data
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["data"]["grant_type"] == "refresh_token"
        assert call_kwargs[1]["data"]["refresh_token"] == "old-refresh-token"

    @patch("services.mstodo_auth.httpx.post")
    def test_refresh_token_failure(self, mock_post):
        """Failed refresh raises HTTPStatusError."""
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.raise_for_status.side_effect = Exception("Unauthorized")
        mock_post.return_value = mock_response

        with pytest.raises(Exception):
            refresh_token(
                client_id="my-client-id",
                client_secret="my-secret",
                refresh_token_value="expired-refresh-token",
            )


# ─── GRAPH CLIENT TESTS (mocked) ──────────────────────────────────────────────

class TestMsGraphClient:
    """Test the Graph API client (mocked)."""

    @patch("services.mstodo_sync.httpx.Client")
    def test_get_lists(self, mock_client_cls):
        """get_lists returns the list of to-do lists."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "value": [
                {"id": "list-1", "displayName": "Work"},
                {"id": "list-2", "displayName": "Personal"},
            ]
        }
        mock_response.raise_for_status = MagicMock()
        mock_client.get.return_value = mock_response

        client = MsGraphClient(access_token="test-token")
        lists = client.get_lists()

        assert len(lists) == 2
        assert lists[0]["id"] == "list-1"
        assert lists[1]["displayName"] == "Personal"

    @patch("services.mstodo_sync.httpx.Client")
    def test_get_tasks(self, mock_client_cls):
        """get_tasks returns the tasks in a list."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "value": [
                {"id": "task-1", "title": "Task 1", "status": "notStarted", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
                {"id": "task-2", "title": "Task 2", "status": "completed", "lastModifiedDateTime": "2026-09-02T00:00:00Z"},
            ]
        }
        mock_response.raise_for_status = MagicMock()
        mock_client.get.return_value = mock_response

        client = MsGraphClient(access_token="test-token")
        tasks = client.get_tasks("list-1")

        assert len(tasks) == 2
        assert tasks[0]["id"] == "task-1"
        assert tasks[1]["status"] == "completed"

    @patch("services.mstodo_sync.httpx.Client")
    def test_create_task(self, mock_client_cls):
        """create_task POSTs to the correct URL and returns the created task."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.json.return_value = {"id": "new-task-id", "title": "New task"}
        mock_response.raise_for_status = MagicMock()
        mock_client.post.return_value = mock_response

        client = MsGraphClient(access_token="test-token")
        body = {"title": "New task", "status": "notStarted"}
        result = client.create_task("list-1", body)

        assert result["id"] == "new-task-id"
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args
        assert "/me/todo/lists/list-1/tasks" in call_args[0][0]

    @patch("services.mstodo_sync.httpx.Client")
    def test_update_task(self, mock_client_cls):
        """update_task PATCHes to the correct URL."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": "task-1", "title": "Updated"}
        mock_response.raise_for_status = MagicMock()
        mock_client.patch.return_value = mock_response

        client = MsGraphClient(access_token="test-token")
        body = {"title": "Updated", "status": "completed"}
        result = client.update_task("list-1", "task-1", body)

        assert result["title"] == "Updated"
        mock_client.patch.assert_called_once()
        call_args = mock_client.patch.call_args
        assert "/me/todo/lists/list-1/tasks/task-1" in call_args[0][0]

    @patch("services.mstodo_sync.httpx.Client")
    def test_delete_task(self, mock_client_cls):
        """delete_task DELETEs to the correct URL."""
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 204
        mock_response.raise_for_status = MagicMock()
        mock_client.delete.return_value = mock_response

        client = MsGraphClient(access_token="test-token")
        client.delete_task("list-1", "task-1")

        mock_client.delete.assert_called_once()
        call_args = mock_client.delete.call_args
        assert "/me/todo/lists/list-1/tasks/task-1" in call_args[0][0]
