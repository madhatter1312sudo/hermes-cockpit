"""hermes-cockpit — dashboard half. Mounted by the gateway at ``/api/plugins/hermes-cockpit/``.

Read-only by default. The single write (``POST /task``) is refused unless ``cockpit.yaml``
sets ``allow_task_create: true``; it then creates a kanban card through Hermes' own
``kanban_db.create_task`` so every invariant (assignee canonicalisation, events) holds.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))  # make ``cockpit_sensor`` importable from the plugin dir
from cockpit_sensor import Sensor  # noqa: E402
from cockpit_sensor.config import hermes_home  # noqa: E402

log = logging.getLogger("cockpit.api")
PLUGIN_ID = "hermes-cockpit"
router = APIRouter()

_sensor: Sensor | None = None


def _broadcast(payload: dict[str, Any]) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except Exception:  # pragma: no cover - outside a gateway
        return
    try:
        broadcast_plugin_event(PLUGIN_ID, "fleet.changed", payload)
    except Exception as exc:  # pragma: no cover
        log.debug("broadcast failed: %s", exc)


def get_sensor() -> Sensor:
    global _sensor
    if _sensor is None:
        _sensor = Sensor(home=hermes_home(), on_change=_broadcast)
        _sensor.start()
    return _sensor


@router.get("/health")
def health() -> dict[str, Any]:
    return get_sensor().health()


@router.get("/config")
def config() -> dict[str, Any]:
    return get_sensor().config.to_public()


@router.get("/fleet")
def fleet() -> dict[str, Any]:
    return get_sensor().snapshot()


@router.get("/feed")
def feed(since: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
    rows = get_sensor().feed(since=since, limit=limit)
    return {"items": rows, "seq": rows[-1]["seq"] if rows else since}


@router.get("/history")
def history(minutes: int = Query(60, ge=1, le=24 * 60)) -> dict[str, Any]:
    return {"points": get_sensor().history(minutes=minutes)}


@router.get("/unit/{profile}")
def unit(profile: str) -> dict[str, Any]:
    d = get_sensor().unit_detail(profile)
    if d is None:
        raise HTTPException(404, f"unknown profile {profile!r}")
    return d


class TaskBody(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=8000)
    assignee: str = Field(min_length=1, max_length=64)
    board: Optional[str] = None
    priority: Optional[str] = None


@router.post("/task")
def create_task(body: TaskBody) -> dict[str, Any]:
    s = get_sensor()
    if not s.config.allow_task_create:
        raise HTTPException(403, "task creation is disabled; set allow_task_create: true in cockpit.yaml")
    try:
        from hermes_cli import kanban_db, kanban_db_connect as kbc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(501, f"kanban not available in this gateway: {exc}")
    board = body.board or (s.snapshot().get("boards") or ["default"])[0]
    assignee = body.assignee if body.assignee.startswith("agent:") or body.assignee == "human" else f"agent:{body.assignee}"
    try:
        with kbc.connect_closing(board=board) as conn:
            kwargs: dict[str, Any] = {"title": body.title, "description": body.description, "assignee": assignee}
            if body.priority:
                kwargs["priority"] = body.priority
            task_id = kanban_db.create_task(conn, created_by="cockpit", board=board, **kwargs)
    except Exception as exc:
        raise HTTPException(400, f"create_task failed: {exc}")
    return {"ok": True, "task_id": task_id, "board": board, "assignee": assignee}
