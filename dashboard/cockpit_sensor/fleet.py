"""The Sensor: polls the sources, derives one state per unit, keeps a feed and a history
ring for replay, detects anomalies, and reports what changed since the last poll.

State precedence (first match wins):
    off      profile disabled, or its gateway heartbeat is stale and nothing else moves
    blocked  a kanban card assigned to it is ``blocked``                 → needs the operator
    failed   a task run or cron job of its failed inside failed_window_s
    task     a kanban task run is running under this profile
    working  a turn lease is held, or a session was active inside working_window_s,
             or one of its cron jobs is executing right now
    idle     everything else
``delegating`` is not a state but a count (running async delegations / subagents) that
rides on top of ``task`` or ``working``.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import sources
from .config import CockpitConfig, hermes_home, load_config

log = logging.getLogger("cockpit.sensor")

STATES = ("off", "blocked", "failed", "task", "working", "idle")


@dataclass
class Unit:
    profile: str
    group: str
    state: str = "idle"
    since: float | None = None
    is_owner: bool = False
    display_name: str = ""
    description: str = ""
    model: str | None = None
    disabled: bool = False
    heartbeat_age_s: float | None = None
    lease_count: int = 0
    active_sessions: int = 0
    delegations: int = 0
    tokens_today: int = 0
    cost_today_usd: float = 0.0
    sessions_today: int = 0
    tokens_per_min: float = 0.0
    latest_session: dict[str, Any] | None = None
    task: dict[str, Any] | None = None
    blocked: list[dict[str, Any]] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)
    cron: dict[str, Any] = field(default_factory=dict)
    anomalies: list[dict[str, Any]] = field(default_factory=list)
    delegated_by: str | None = None    # profile that created the running task (for the edge)

    def to_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        return d


class Sensor:
    """One instance per gateway process. ``poll()`` is cheap enough to run every few seconds."""

    def __init__(self, home: Path | None = None, config: CockpitConfig | None = None,
                 on_change: Callable[[dict[str, Any]], None] | None = None):
        self.home = home or hermes_home()
        self.config = config or load_config(self.home)
        self.on_change = on_change
        self._lock = threading.RLock()
        self._rev = 0
        self._snapshot: dict[str, Any] | None = None
        self._prev_states: dict[str, str] = {}
        self._since: dict[str, float] = {}
        self._rate_window: dict[str, deque[tuple[float, int]]] = {}
        self._history: deque[dict[str, Any]] = deque(maxlen=max(60, int(self.config.thresholds.history_minutes * 60 / max(1.0, self.config.thresholds.poll_interval_s))))
        self._feed: deque[dict[str, Any]] = deque(maxlen=self.config.thresholds.feed_size)
        self._feed_seq = 0
        self._kanban_event_cursor: dict[str, int] = {}
        self._last_error: str | None = None
        self._config_mtime: float | None = self._config_stat()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    # ── lifecycle ────────────────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Background poller (daemon). Safe to call twice."""
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="cockpit-sensor", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll()
            except Exception as exc:  # never let the poller die
                self._last_error = f"{type(exc).__name__}: {exc}"
                log.warning("cockpit poll failed: %s", exc)
            self._stop.wait(self.config.thresholds.poll_interval_s)

    def _config_stat(self) -> float | None:
        p = self.home / "cockpit.yaml"
        try:
            return p.stat().st_mtime
        except OSError:
            return None

    def reload_config_if_changed(self) -> bool:
        m = self._config_stat()
        if m != self._config_mtime:
            self._config_mtime = m
            try:
                self.config = load_config(self.home)
                self._push_feed("config", "cockpit.yaml reloaded", profile=None)
                return True
            except Exception as exc:
                self._last_error = f"config: {exc}"
        return False

    # ── polling ──────────────────────────────────────────────────────────────────────────

    def poll(self, now: float | None = None) -> dict[str, Any]:
        now = now or time.time()
        self.reload_config_if_changed()
        cfg, th = self.config, self.config.thresholds
        profiles = [p for p in sources.discover_profiles(self.home) if p not in cfg.hide_profiles]
        kanban = sources.read_kanban(now=now, failed_window_s=th.failed_window_s, home=self.home,
                                     boards=cfg.kanban_boards, since_event_id=self._kanban_event_cursor)
        units: dict[str, Unit] = {}
        for name in profiles:
            units[name] = self._unit_for(name, now, kanban)
        # groups: configured first, then "other" for the rest (owner seat always in its own group)
        groups = [{"id": g.id, "label": g.label, "profiles": [p for p in g.profiles if p in units]} for g in cfg.groups]
        placed = {p for g in groups for p in g["profiles"]}
        rest = [p for p in profiles if p not in placed]
        if rest:
            groups.append({"id": "other", "label": cfg.other_group_label if cfg.groups else "Fleet", "profiles": rest})
        # delegation edges from task creator → assignee
        for u in units.values():
            if u.task and u.task.get("created_by"):
                creator = sources.assignee_profile(u.task["created_by"])
                if creator in units and creator != u.profile:
                    u.delegated_by = creator
        # transitions → feed + since
        changes: list[dict[str, Any]] = []
        for name, u in units.items():
            prev = self._prev_states.get(name)
            if prev != u.state:
                if prev is not None:
                    changes.append({"profile": name, "from": prev, "to": u.state})
                    self._push_feed("state", f"{name}: {prev} → {u.state}", profile=name, now=now)
                self._since[name] = now
            u.since = self._since.get(name, now)
            self._prev_states[name] = u.state
        for name in list(self._prev_states):
            if name not in units:
                del self._prev_states[name]
        # kanban events → feed (newest first in snap; push oldest first)
        for ev in sorted(kanban.recent_events, key=lambda e: e["id"]):
            self._kanban_event_cursor[ev["board"]] = max(self._kanban_event_cursor.get(ev["board"], 0), int(ev["id"]))
            self._push_feed("kanban", f"{ev.get('kind')} · {ev.get('title') or ev.get('task_id')}", profile=ev.get("profile"),
                            now=float(ev.get("created_at") or now), extra={"task_id": ev.get("task_id"), "event": ev.get("kind"), "board": ev["board"]})
        # signals
        signals = []
        for s in cfg.signals:
            age = sources.file_age_s(Path(s.path).expanduser(), now)
            signals.append({"id": s.id, "label": s.label, "age_s": None if age is None else round(age, 1),
                            "ok": age is not None and age <= s.warn_after_s, "warn_after_s": s.warn_after_s})
        totals = {
            "units": len(units),
            "by_state": {s: sum(1 for u in units.values() if u.state == s) for s in STATES},
            "needs_you": sum(1 for u in units.values() if u.state == "blocked"),
            "delegations": sum(u.delegations for u in units.values()),
            "tokens_today": sum(u.tokens_today for u in units.values()),
            "cost_today_usd": round(sum(u.cost_today_usd for u in units.values()), 4),
            "tokens_per_min": round(sum(u.tokens_per_min for u in units.values()), 1),
        }
        gateway = {"heartbeat_age_s": min((u.heartbeat_age_s for u in units.values() if u.heartbeat_age_s is not None), default=None)}
        self._rev += 1
        snap = {
            "rev": self._rev, "ts": now, "mode": "live", "title": cfg.title, "owner": cfg.owner_profile,
            "spend_ceiling_usd": cfg.spend_ceiling_usd, "groups": groups,
            "units": {n: u.to_dict() for n, u in units.items()}, "totals": totals,
            "pipeline": kanban.pipeline, "boards": kanban.boards, "signals": signals, "gateway": gateway,
            "last_error": self._last_error, "feed_seq": self._feed_seq,
        }
        with self._lock:
            self._snapshot = snap
            self._history.append({"ts": now, "states": {n: u.state for n, u in units.items()},
                                  "tpm": {n: round(u.tokens_per_min, 1) for n, u in units.items() if u.tokens_per_min},
                                  "edges": {n: u.delegated_by for n, u in units.items() if u.delegated_by}})
        if changes and self.on_change:
            try:
                self.on_change({"rev": self._rev, "changes": changes, "needs_you": totals["needs_you"]})
            except Exception as exc:  # pragma: no cover
                log.debug("on_change failed: %s", exc)
        return snap

    def _unit_for(self, name: str, now: float, kanban: sources.KanbanSnapshot) -> Unit:
        cfg, th = self.config, self.config.thresholds
        g = cfg.group_of(name)
        meta = sources.profile_meta(name, self.home)
        st = sources.read_profile_state(name, now=now, working_window_s=th.working_window_s, home=self.home)
        cron = sources.read_cron(name, now=now, failed_window_s=th.failed_window_s, home=self.home)
        u = Unit(profile=name, group=g.id if g else "other", is_owner=(name == cfg.owner_profile),
                 display_name=meta["display_name"], description=meta["description"], model=meta["model"] or st.latest_model or None,
                 disabled=meta["disabled"], heartbeat_age_s=None if st.heartbeat_age_s is None else round(st.heartbeat_age_s, 1),
                 lease_count=st.lease_count, active_sessions=st.active_sessions, delegations=st.running_delegations,
                 tokens_today=st.tokens_today, cost_today_usd=round(st.cost_today_usd, 4), sessions_today=st.sessions_today)
        if st.latest_session_id:
            u.latest_session = {"id": st.latest_session_id, "title": st.latest_title, "source": st.latest_source, "model": st.latest_model,
                                "last_activity_at": st.latest_activity_at, "tool_calls": st.latest_tool_calls, "tokens": st.latest_tokens}
        running = kanban.running_by_profile.get(name) or []
        u.blocked = kanban.blocked_by_profile.get(name) or []
        u.failed = kanban.failed_by_profile.get(name) or []
        u.cron = {"jobs": len(cron.jobs), "running": cron.running, "errors_recent": cron.errors_recent, "paused": cron.paused,
                  "next_run_at": cron.next_run_at, "list": cron.jobs[:20]}
        if running:
            r = running[0]
            u.task = {"id": r.get("task_id"), "run_id": r.get("run_id"), "title": r.get("title"), "started_at": r.get("started_at"),
                      "created_by": r.get("created_by"), "board": r.get("board"), "last_heartbeat_at": r.get("last_heartbeat_at")}
        # tokens/min from a 60-second window of tokens_today deltas
        win = self._rate_window.setdefault(name, deque(maxlen=64))
        win.append((now, st.tokens_today))
        while win and win[0][0] < now - 60:
            win.popleft()
        if len(win) >= 2 and win[-1][0] > win[0][0]:
            delta = max(0, win[-1][1] - win[0][1])
            u.tokens_per_min = round(delta * 60.0 / (win[-1][0] - win[0][0]), 1)
        stale_hb = st.heartbeat_age_s is not None and st.heartbeat_age_s > th.stale_heartbeat_s
        active = st.lease_count > 0 or st.active_sessions > 0 or cron.running > 0 or bool(running)
        if u.disabled or (stale_hb and not active and st.heartbeat_age_s is not None and st.heartbeat_age_s > 6 * th.stale_heartbeat_s and not u.blocked):
            u.state = "off"
        elif u.blocked:
            u.state = "blocked"
        elif u.failed or cron.errors_recent:
            u.state = "failed"
        elif running:
            u.state = "task"
        elif active:
            u.state = "working"
        else:
            u.state = "idle"
        u.anomalies = self._anomalies(u, now)
        return u

    def _anomalies(self, u: Unit, now: float) -> list[dict[str, Any]]:
        th = self.config.thresholds
        out: list[dict[str, Any]] = []
        if u.task and u.task.get("started_at") and now - float(u.task["started_at"]) > th.long_task_s:
            out.append({"rule": "long-task", "evidence": f"task {u.task.get('id')} running {int((now - float(u.task['started_at'])) / 60)} min"})
        if u.task and u.task.get("last_heartbeat_at") and now - float(u.task["last_heartbeat_at"]) > 3 * 60:
            out.append({"rule": "silent-heartbeat", "evidence": f"last task heartbeat {int(now - float(u.task['last_heartbeat_at']))} s ago"})
        if u.state in ("working", "task") and u.latest_session:
            calls = sources.read_recent_tool_calls(u.profile, u.latest_session["id"], limit=40, home=self.home)
            if calls:
                key = lambda c: (c["tool"], c["target"])
                counts: dict[tuple[str, str], int] = {}
                for c in calls:
                    counts[key(c)] = counts.get(key(c), 0) + 1
                worst = max(counts.items(), key=lambda kv: kv[1])
                if worst[1] >= th.repeat_tool_calls and worst[0][1]:
                    out.append({"rule": "repeat-call", "evidence": f"{worst[0][0]} on {worst[0][1][:60]} × {worst[1]} in the last {len(calls)} calls"})
        return out

    # ── feed / history / readers ─────────────────────────────────────────────────────────

    def _push_feed(self, kind: str, text: str, *, profile: str | None, now: float | None = None, extra: dict[str, Any] | None = None) -> None:
        self._feed_seq += 1
        entry = dict(extra or {})
        entry.update({"seq": self._feed_seq, "ts": now or time.time(), "kind": kind, "profile": profile, "text": text})
        self._feed.append(entry)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            if self._snapshot is None:
                return self.poll()
            return self._snapshot

    def feed(self, since: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = [e for e in self._feed if e["seq"] > since]
        return rows[-limit:]

    def history(self, minutes: int = 60) -> list[dict[str, Any]]:
        cutoff = time.time() - minutes * 60
        with self._lock:
            return [h for h in self._history if h["ts"] >= cutoff]

    def unit_detail(self, profile: str) -> dict[str, Any] | None:
        snap = self.snapshot()
        u = snap["units"].get(profile)
        if not u:
            return None
        detail = dict(u)
        sid = (u.get("latest_session") or {}).get("id")
        detail["recent_tool_calls"] = sources.read_recent_tool_calls(profile, sid, limit=12, home=self.home)
        st = sources.read_profile_state(profile, now=time.time(), working_window_s=self.config.thresholds.working_window_s, home=self.home)
        detail["recent_sessions"] = st.recent_sessions
        return detail

    def health(self) -> dict[str, Any]:
        snap = self._snapshot
        return {"ok": True, "rev": self._rev, "last_poll_ts": snap["ts"] if snap else None, "units": len(snap["units"]) if snap else 0,
                "poller_alive": bool(self._thread and self._thread.is_alive()), "last_error": self._last_error,
                "home": str(self.home), "config_path": self.config.source_path, "history_points": len(self._history)}
