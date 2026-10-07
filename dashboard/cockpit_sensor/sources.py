"""Read-only readers over the files Hermes keeps. Each function tolerates a missing file,
a locked database or a schema it does not know (returns an empty result), because the
sensor polls every few seconds and one bad read must never take the picture down.

Timestamps: Hermes stores epoch floats in ``state.db``, epoch ints in the kanban DB and
ISO-8601 strings in cron files. Everything leaves this module as epoch seconds (float).
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import hermes_home

TaskRow = dict[str, Any]


# ── helpers ──────────────────────────────────────────────────────────────────────────────


def _ro(path: Path) -> sqlite3.Connection | None:
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.5)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def _rows(conn: sqlite3.Connection | None, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    if conn is None:
        return []
    try:
        return list(conn.execute(sql, args))
    except sqlite3.Error:
        return []


def _one(conn: sqlite3.Connection | None, sql: str, args: tuple = ()) -> sqlite3.Row | None:
    rows = _rows(conn, sql, args)
    return rows[0] if rows else None


def iso_to_epoch(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def local_midnight(now: float | None = None) -> float:
    now = now or time.time()
    lt = time.localtime(now)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def file_age_s(path: Path, now: float | None = None) -> float | None:
    try:
        return (now or time.time()) - path.stat().st_mtime
    except OSError:
        return None


# ── profiles ─────────────────────────────────────────────────────────────────────────────


def profile_home(name: str, home: Path | None = None) -> Path:
    home = home or hermes_home()
    return home if name == "default" else home / "profiles" / name


def discover_profiles(home: Path | None = None) -> list[str]:
    """``default`` plus every directory under ``profiles/`` that looks like a profile."""
    home = home or hermes_home()
    names = ["default"]
    pdir = home / "profiles"
    if pdir.is_dir():
        for child in sorted(pdir.iterdir(), key=lambda p: p.name):
            if not child.is_dir() or child.name.startswith(".") or child.name.startswith("_"):
                continue
            if (child / "config.yaml").exists() or (child / "state.db").exists() or (child / "profile.yaml").exists():
                names.append(child.name)
    return names


def profile_meta(name: str, home: Path | None = None) -> dict[str, Any]:
    """Model / display name / description from ``profile.yaml`` + ``config.yaml`` (cheap text reads)."""
    ph = profile_home(name, home)
    meta: dict[str, Any] = {"display_name": "", "description": "", "model": None, "disabled": False}
    try:
        import yaml  # type: ignore
    except Exception:  # pragma: no cover
        return meta
    for fname in ("profile.yaml", "config.yaml"):
        p = ph / fname
        if not p.is_file():
            continue
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        if fname == "profile.yaml":
            meta["display_name"] = str(data.get("display_name") or data.get("name") or meta["display_name"])
            meta["description"] = str(data.get("description") or meta["description"])
            if data.get("disabled") is True or data.get("enabled") is False:
                meta["disabled"] = True
        else:
            model = data.get("model")
            if isinstance(model, dict):
                meta["model"] = model.get("default") or model.get("name")
            elif isinstance(model, str):
                meta["model"] = model
    return meta


# ── state.db (sessions, leases, delegations, heartbeats, usage) ──────────────────────────


@dataclass
class ProfileState:
    profile: str
    lease_count: int = 0
    active_sessions: int = 0          # unfinished sessions touched inside working_window_s
    latest_session_id: str | None = None
    latest_activity_at: float | None = None
    latest_title: str = ""
    latest_source: str = ""
    latest_model: str = ""
    latest_tool_calls: int = 0
    latest_tokens: int = 0
    running_delegations: int = 0
    heartbeat_age_s: float | None = None
    tokens_today: int = 0
    cost_today_usd: float = 0.0
    sessions_today: int = 0
    tokens_window: int = 0            # tokens in sessions active in the last 60 s (rate proxy)
    recent_sessions: list[dict[str, Any]] = field(default_factory=list)


def read_profile_state(name: str, *, now: float, working_window_s: int, home: Path | None = None) -> ProfileState:
    st = ProfileState(profile=name)
    conn = _ro(profile_home(name, home) / "state.db")
    if conn is None:
        return st
    try:
        r = _one(conn, "select count(*) n from session_turn_leases where expires_at > ?", (now,))
        st.lease_count = int(r["n"]) if r else 0
        r = _one(conn, "select count(*) n from async_delegations where state in ('running','dispatched','pending')")
        st.running_delegations = int(r["n"]) if r else 0
        r = _one(conn, "select max(last_heartbeat) h from gateway_heartbeats")
        if r and r["h"]:
            st.heartbeat_age_s = max(0.0, now - float(r["h"]))
        midnight = local_midnight(now)
        r = _one(conn, "select coalesce(sum(input_tokens+output_tokens),0) t, coalesce(sum(estimated_cost_usd),0) c, count(*) n "
                       "from sessions where coalesce(last_activity_at, started_at) >= ?", (midnight,))
        if r:
            st.tokens_today, st.cost_today_usd, st.sessions_today = int(r["t"] or 0), float(r["c"] or 0.0), int(r["n"] or 0)
        rows = _rows(conn, "select id, title, source, model, started_at, ended_at, last_activity_at, message_count, tool_call_count, "
                           "input_tokens, output_tokens, estimated_cost_usd from sessions "
                           "order by coalesce(last_activity_at, started_at) desc limit 8")
        for row in rows:
            d = dict(row)
            la = d.get("last_activity_at") or d.get("started_at") or 0
            d["tokens"] = int(d.get("input_tokens") or 0) + int(d.get("output_tokens") or 0)
            st.recent_sessions.append({k: d.get(k) for k in ("id", "title", "source", "model", "started_at", "ended_at",
                                                              "last_activity_at", "message_count", "tool_call_count", "tokens",
                                                              "estimated_cost_usd")})
            if d.get("ended_at") is None and la >= now - working_window_s:
                st.active_sessions += 1
            if la >= now - 60:
                st.tokens_window += d["tokens"]
        if rows:
            top = dict(rows[0])
            st.latest_session_id = top.get("id")
            st.latest_activity_at = top.get("last_activity_at") or top.get("started_at")
            st.latest_title = top.get("title") or ""
            st.latest_source = top.get("source") or ""
            st.latest_model = top.get("model") or ""
            st.latest_tool_calls = int(top.get("tool_call_count") or 0)
            st.latest_tokens = int(top.get("input_tokens") or 0) + int(top.get("output_tokens") or 0)
    finally:
        conn.close()
    return st


def read_recent_tool_calls(name: str, session_id: str | None, limit: int = 40, home: Path | None = None) -> list[dict[str, Any]]:
    """Last tool calls of one session (for the drawer's live steps and the repeat-call anomaly).

    The ``messages`` table shape differs across Hermes versions; we read defensively and
    give up quietly when the columns are not there.
    """
    if not session_id:
        return []
    conn = _ro(profile_home(name, home) / "state.db")
    if conn is None:
        return []
    try:
        cols = {r["name"] for r in _rows(conn, "pragma table_info(messages)")}
        if not {"session_id", "role", "content"} <= cols:
            return []
        ts_col = "timestamp" if "timestamp" in cols else ("created_at" if "created_at" in cols else None)
        tc_col = "tool_calls" if "tool_calls" in cols else None
        if not tc_col:
            return []
        order = f"order by {ts_col} desc" if ts_col else "order by rowid desc"
        rows = _rows(conn, f"select {tc_col} tc{', ' + ts_col + ' ts' if ts_col else ''} from messages "
                           f"where session_id=? and role='assistant' and {tc_col} is not null {order} limit ?", (session_id, limit))
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                calls = json.loads(row["tc"]) if isinstance(row["tc"], str) else row["tc"]
            except Exception:
                continue
            for call in calls or []:
                fn = (call or {}).get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {"raw": args[:120]}
                target = ""
                if isinstance(args, dict):
                    target = str(args.get("path") or args.get("file_path") or args.get("command") or args.get("query") or args.get("url") or "")[:120]
                out.append({"tool": fn.get("name") or "?", "target": target, "ts": row["ts"] if ts_col else None})
        return out[:limit]
    finally:
        conn.close()


# ── kanban ───────────────────────────────────────────────────────────────────────────────


def kanban_db_paths(home: Path | None = None, boards: list[str] | None = None) -> list[tuple[str, Path]]:
    home = home or hermes_home()
    found: list[tuple[str, Path]] = []
    root = home / "kanban" / "boards"
    if root.is_dir():
        for b in sorted(root.iterdir(), key=lambda p: p.name):
            db = b / "kanban.db"
            if db.is_file() and db.stat().st_size > 0 and (boards is None or b.name in boards):
                found.append((b.name, db))
    legacy = home / "kanban.db"
    if not found and legacy.is_file() and legacy.stat().st_size > 0 and (boards is None or "default" in boards):
        found.append(("default", legacy))
    return found


def assignee_profile(assignee: str | None) -> str | None:
    if not assignee:
        return None
    a = str(assignee)
    return a.split(":", 1)[1] if a.startswith("agent:") else a


@dataclass
class KanbanSnapshot:
    boards: list[str] = field(default_factory=list)
    pipeline: dict[str, int] = field(default_factory=dict)
    running_by_profile: dict[str, list[TaskRow]] = field(default_factory=dict)
    blocked_by_profile: dict[str, list[TaskRow]] = field(default_factory=dict)
    failed_by_profile: dict[str, list[TaskRow]] = field(default_factory=dict)
    recent_events: list[dict[str, Any]] = field(default_factory=list)
    recently_done: list[TaskRow] = field(default_factory=list)
    open_tasks: list[TaskRow] = field(default_factory=list)


def read_kanban(*, now: float, failed_window_s: int, home: Path | None = None, boards: list[str] | None = None,
                since_event_id: dict[str, int] | None = None) -> KanbanSnapshot:
    snap = KanbanSnapshot()
    for board, db in kanban_db_paths(home, boards):
        conn = _ro(db)
        if conn is None:
            continue
        snap.boards.append(board)
        try:
            for r in _rows(conn, "select status, count(*) n from tasks group by status"):
                snap.pipeline[r["status"]] = snap.pipeline.get(r["status"], 0) + int(r["n"])
            task_cols = "id, title, assignee, status, priority, created_by, created_at, started_at, completed_at, block_kind, session_id, current_run_id, last_heartbeat_at"
            for r in _rows(conn, f"select {task_cols} from tasks where status in ('running','blocked','ready','todo','review','triage','in_progress') "
                                 "order by created_at desc limit 300"):
                t = dict(r)
                t["board"] = board
                prof = assignee_profile(t.get("assignee"))
                t["profile"] = prof
                snap.open_tasks.append(t)
                if prof and t["status"] == "blocked":
                    snap.blocked_by_profile.setdefault(prof, []).append(t)
            for r in _rows(conn, "select r.id run_id, r.task_id, r.profile, r.status, r.outcome, r.started_at, r.ended_at, r.last_heartbeat_at, r.summary, "
                                 "t.title, t.created_by, t.assignee, t.status task_status from task_runs r left join tasks t on t.id=r.task_id "
                                 "where r.status='running' or r.started_at >= ? order by r.started_at desc limit 200", (int(now - failed_window_s),)):
                run = dict(r)
                run["board"] = board
                prof = run.get("profile") or assignee_profile(run.get("assignee"))
                if not prof:
                    continue
                if run["status"] == "running":
                    snap.running_by_profile.setdefault(prof, []).append(run)
                elif (run.get("outcome") or "") in ("failed", "error", "timeout", "crashed") and (run.get("ended_at") or 0) >= now - failed_window_s:
                    snap.failed_by_profile.setdefault(prof, []).append(run)
                elif (run.get("outcome") or "") in ("completed", "done") and (run.get("ended_at") or 0) >= now - failed_window_s:
                    snap.recently_done.append(run)
            last_id = (since_event_id or {}).get(board, 0)
            for r in _rows(conn, "select e.id, e.task_id, e.run_id, e.kind, e.payload, e.created_at, t.title, t.assignee "
                                 "from task_events e left join tasks t on t.id=e.task_id where e.id > ? and e.kind not in ('heartbeat') "
                                 "order by e.id desc limit 120", (last_id,)):
                ev = dict(r)
                ev["board"] = board
                ev["profile"] = assignee_profile(ev.get("assignee"))
                snap.recent_events.append(ev)
        finally:
            conn.close()
    return snap


# ── cron ─────────────────────────────────────────────────────────────────────────────────


@dataclass
class CronSnapshot:
    jobs: list[dict[str, Any]] = field(default_factory=list)
    running: int = 0
    errors_recent: int = 0
    next_run_at: float | None = None
    paused: int = 0


def read_cron(name: str, *, now: float, failed_window_s: int, home: Path | None = None) -> CronSnapshot:
    snap = CronSnapshot()
    cdir = profile_home(name, home) / "cron"
    jobs_file = cdir / "jobs.json"
    if jobs_file.is_file():
        try:
            data = json.loads(jobs_file.read_text(encoding="utf-8"))
            jobs = data.get("jobs", data) if isinstance(data, dict) else data
        except Exception:
            jobs = []
        for j in jobs or []:
            if not isinstance(j, dict):
                continue
            nxt = iso_to_epoch(j.get("next_run_at"))
            last = iso_to_epoch(j.get("last_run_at"))
            row = {
                "id": j.get("id"), "name": j.get("name"), "schedule": (j.get("schedule") or {}).get("display") if isinstance(j.get("schedule"), dict) else j.get("schedule"),
                "enabled": bool(j.get("enabled", True)), "paused": bool(j.get("paused_at")), "state": j.get("state"),
                "last_status": j.get("last_status"), "last_run_at": last, "next_run_at": nxt, "last_error": (j.get("last_error") or "")[:200] or None,
            }
            snap.jobs.append(row)
            if row["paused"] or not row["enabled"]:
                snap.paused += 1
            if row["last_status"] in ("error", "failed") and last and last >= now - failed_window_s:
                snap.errors_recent += 1
            if nxt and row["enabled"] and not row["paused"] and (snap.next_run_at is None or nxt < snap.next_run_at):
                snap.next_run_at = nxt
    conn = _ro(cdir / "executions.db")
    if conn is not None:
        try:
            r = _one(conn, "select count(*) n from executions where status in ('running','claimed','started') and finished_at is null")
            snap.running = int(r["n"]) if r else 0
        finally:
            conn.close()
    return snap
