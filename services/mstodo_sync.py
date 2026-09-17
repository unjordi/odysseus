"""Microsoft Graph To-Do sync — bidirectional reconciliation with tombstones.

Design:
- Mirrors caldav_sync.py pattern: pull (remote → local) + push (local → remote).
- Uses Microsoft Graph API (https://graph.microsoft.com/v1.0/me/todo/lists).
- Tokens stored encrypted per-user via src/secret_storage (same pattern as EmailAccount).
- Reconciliation is pure (reconcile.ts logic ported to Python): last-write-wins by updatedAt,
  tombstones for deletes, never-throws on malformed remote data.
- All Graph I/O is mocked in tests (requests.mock) — no real Azure registration needed yet.
"""

import json
import logging
import time
from datetime import datetime
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Graph API base URL
GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphTodoTask:
    """A todoTask from Microsoft Graph (loosely typed: JSON from a third party)."""

    def __init__(self, data: dict):
        self.data = data

    @property
    def id(self) -> Optional[str]:
        v = self.data.get("id")
        return v if isinstance(v, str) and v else None

    @property
    def title(self) -> Optional[str]:
        v = self.data.get("title")
        return v if isinstance(v, str) and v else None

    @property
    def status(self) -> Optional[str]:
        """Graph status: notStarted, inProgress, completed, waitingOnOthers, deferred."""
        return self.data.get("status")

    @property
    def due_date_time(self) -> Optional[str]:
        """ISO-8601 datetime from dueDateTime.dateTime (or None)."""
        due = self.data.get("dueDateTime")
        if isinstance(due, dict):
            dt = due.get("dateTime")
            return dt if isinstance(dt, str) and dt else None
        return None

    @property
    def last_modified_date_time(self) -> Optional[str]:
        """ISO-8601 datetime from lastModifiedDateTime."""
        v = self.data.get("lastModifiedDateTime")
        return v if isinstance(v, str) and v else None


class GraphTodoList:
    """A todoTaskList from Microsoft Graph."""

    def __init__(self, data: dict):
        self.data = data

    @property
    def id(self) -> Optional[str]:
        v = self.data.get("id")
        return v if isinstance(v, str) and v else None

    @property
    def display_name(self) -> Optional[str]:
        v = self.data.get("displayName")
        return v if isinstance(v, str) and v else None


class RemoteTodo:
    """A task as seen by the remote service (Graph). Mirrors reconcile.ts RemoteTodo."""

    def __init__(
        self,
        id: str,
        title: str,
        status: str,  # "open" or "done"
        list_id: str,
        updated_at: str,
        due: Optional[str] = None,
    ):
        self.id = id
        self.title = title
        self.status = status
        self.list_id = list_id
        self.updated_at = updated_at
        self.due = due

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "listId": self.list_id,
            "updatedAt": self.updated_at,
        }
        if self.due is not None:
            d["due"] = self.due
        return d


def graph_task_to_remote_todo(task: GraphTodoTask, list_id: str) -> Optional[RemoteTodo]:
    """Convert a Graph todoTask to RemoteTodo. Returns None if id or lastModifiedDateTime is missing
    (reconciliation needs both). Never throws.
    """
    task_id = task.id
    updated_at = task.last_modified_date_time
    if not task_id or not updated_at:
        return None
    due = task.due_date_time
    title = task.title or ""
    # Graph status: "completed" → "done", anything else → "open"
    status = "done" if task.status == "completed" else "open"
    return RemoteTodo(
        id=task_id,
        title=title,
        status=status,
        list_id=list_id,
        updated_at=updated_at,
        due=due,
    )


def graph_tasks_to_remote_todos(tasks: list, list_id: str) -> list[RemoteTodo]:
    """Convert a list of Graph todoTasks to RemoteTodos, skipping unmappable rows."""
    out = []
    for t in tasks:
        task = GraphTodoTask(t if isinstance(t, dict) else {})
        remote = graph_task_to_remote_todo(task, list_id)
        if remote:
            out.append(remote)
    return out


def todo_item_to_graph_body(item: dict) -> dict:
    """Convert a local TodoItem to a Graph todoTask body (for POST/PATCH).
    Does not include 'id' (URL-provided in PATCH, server-assigned in POST).
    """
    body = {
        "title": item.get("title", ""),
        "status": "completed" if item.get("status") == "done" else "notStarted",
    }
    due = item.get("due")
    if due:
        body["dueDateTime"] = {"dateTime": due, "timeZone": "UTC"}
    return body


class MsGraphClient:
    """Microsoft Graph API client for To-Do lists and tasks."""

    def __init__(self, access_token: str, timeout: float = 10.0):
        self.access_token = access_token
        self.timeout = timeout
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=timeout,
        )

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    def get_lists(self) -> list[dict]:
        """Fetch all to-do lists for the user. Returns list of {id, displayName, ...}."""
        resp = self.client.get(f"{GRAPH_BASE}/me/todo/lists")
        resp.raise_for_status()
        data = resp.json()
        return data.get("value", [])

    def get_tasks(self, list_id: str) -> list[dict]:
        """Fetch all tasks in a list. Returns list of {id, title, status, dueDateTime, lastModifiedDateTime, ...}."""
        resp = self.client.get(f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks")
        resp.raise_for_status()
        data = resp.json()
        return data.get("value", [])

    def create_task(self, list_id: str, body: dict) -> dict:
        """Create a task in a list. Returns the created task {id, ...}."""
        resp = self.client.post(f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks", json=body)
        resp.raise_for_status()
        return resp.json()

    def update_task(self, list_id: str, task_id: str, body: dict) -> dict:
        """Update a task. Returns the updated task."""
        resp = self.client.patch(
            f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks/{task_id}",
            json=body,
        )
        resp.raise_for_status()
        return resp.json()

    def delete_task(self, list_id: str, task_id: str) -> None:
        """Delete a task."""
        resp = self.client.delete(f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks/{task_id}")
        resp.raise_for_status()


def reconcile(
    local_items: list[dict],
    remote_todos: list[RemoteTodo],
) -> dict:
    """Reconcile local items with remote todos. Pure function, never throws.
    Returns {"push": [...], "pull": [...], "conflicts": [...]}.
    Mirrors reconcile.ts logic: last-write-wins by updatedAt, tombstones for deletes.
    """
    push = []
    pull = []
    conflicts = []

    local_by_id = {item["id"]: item for item in local_items}
    remote_by_id = {todo.id: todo for todo in remote_todos}

    # 1) ids only in local → push (creation or delete)
    for item_id, item in local_by_id.items():
        if item_id not in remote_by_id:
            if item.get("deleted"):
                push.append({"kind": "delete", "id": item_id})
            else:
                push.append({"kind": "upsert", "item": item})

    # 2) ids only in remote → pull (creation)
    for todo_id, todo in remote_by_id.items():
        if todo_id not in local_by_id:
            item = {
                "id": todo.id,
                "title": todo.title,
                "status": todo.status,
                "listId": todo.list_id,
                "updatedAt": todo.updated_at,
                "deleted": False,
            }
            if todo.due:
                item["due"] = todo.due
            pull.append({"kind": "upsert", "item": item})

    # 3) ids in both → resolve conflict (or propagate delete)
    for item_id, local_item in local_by_id.items():
        remote_todo = remote_by_id.get(item_id)
        if not remote_todo:
            continue
        if local_item.get("deleted"):
            # Local delete always propagates (delete > edit)
            push.append({"kind": "delete", "id": item_id})
            continue
        # Both alive: last-write-wins by updatedAt
        local_updated = local_item.get("updatedAt", "")
        remote_updated = remote_todo.updated_at
        if local_updated > remote_updated:
            # Local more recent → push
            push.append({"kind": "upsert", "item": local_item})
            conflicts.append(item_id)
        elif local_updated < remote_updated:
            # Remote more recent → pull
            item = {
                "id": remote_todo.id,
                "title": remote_todo.title,
                "status": remote_todo.status,
                "listId": remote_todo.list_id,
                "updatedAt": remote_todo.updated_at,
                "deleted": False,
            }
            if remote_todo.due:
                item["due"] = remote_todo.due
            pull.append({"kind": "upsert", "item": item})
            conflicts.append(item_id)
        # else: tie → local wins (no op)

    return {"push": push, "pull": pull, "conflicts": conflicts}
