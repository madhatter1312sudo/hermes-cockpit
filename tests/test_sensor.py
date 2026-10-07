"""Sensor tests against a synthetic HERMES_HOME (no Hermes import needed)."""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))

from cockpit_sensor import Sensor  # noqa: E402
from cockpit_sensor.config import load_config, parse_config  # noqa: E402
from cockpit_sensor import sources  # noqa: E402

NOW = 1_800_000_000.0


def _state_db(path: Path, *, sessions=(), leases=(), hb=None, delegations=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript("""
    create table sessions(id text primary key, title text, source text, model text, started_at real, ended_at real,
        last_activity_at real, message_count int, tool_call_count int, input_tokens int, output_tokens int, estimated_cost_usd real);
    create table session_turn_leases(session_id text, expires_at real);
    create table async_delegations(delegation_id text, state text);
    create table gateway_heartbeats(gateway_id text, last_heartbeat real);
    create table messages(id integer primary key, session_id text, role text, content text, tool_calls text, timestamp real);
    """)
    for s in sessions:
        c.execute("insert into sessions values(?,?,?,?,?,?,?,?,?,?,?,?)", s)
    for l in leases:
        c.execute("insert into session_turn_leases values(?,?)", l)
    for i in range(delegations):
        c.execute("insert into async_delegations values(?,?)", (f"d{i}", "running"))
    if hb is not None:
        c.execute("insert into gateway_heartbeats values('g', ?)", (hb,))
    c.commit()
    c.close()


def _kanban(path: Path, tasks=(), runs=(), events=()):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript("""
    create table tasks(id text primary key, title text, assignee text, status text, priority text, created_by text, created_at int,
        started_at int, completed_at int, block_kind text, session_id text, current_run_id text, last_heartbeat_at int);
    create table task_runs(id text primary key, task_id text, profile text, status text, outcome text, started_at int, ended_at int,
        last_heartbeat_at int, worker_pid int, summary text);
    create table task_events(id integer primary key, task_id text, run_id text, kind text, payload text, created_at int);
    """)
    for t in tasks:
        c.execute("insert into tasks values(?,?,?,?,?,?,?,?,?,?,?,?,?)", t)
    for r in runs:
        c.execute("insert into task_runs values(?,?,?,?,?,?,?,?,?,?)", r)
    for e in events:
        c.execute("insert into task_events(task_id,run_id,kind,payload,created_at) values(?,?,?,?,?)", e)
    c.commit()
    c.close()


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "hermes"
    (h / "profiles").mkdir(parents=True)
    # default: owner, idle, fresh heartbeat
    _state_db(h / "state.db", hb=NOW - 5)
    # chief: working (lease held), 2 delegations
    (h / "profiles/chief").mkdir()
    (h / "profiles/chief/config.yaml").write_text("model:\n  default: glm-5.3-flash\n")
    _state_db(h / "profiles/chief/state.db", hb=NOW - 3, delegations=2,
              sessions=[("s1", "Morning brief", "whatsapp", "glm-5.3-flash", NOW - 600, None, NOW - 10, 12, 7, 20000, 4000, 0.012)],
              leases=[("s1", NOW + 60)])
    # sourcer: has a running kanban task
    (h / "profiles/sourcer").mkdir()
    (h / "profiles/sourcer/config.yaml").write_text("model: deepseek-v4-flash\n")
    _state_db(h / "profiles/sourcer/state.db", hb=NOW - 3)
    # editor: blocked card
    (h / "profiles/editor").mkdir()
    _state_db(h / "profiles/editor/state.db", hb=NOW - 3)
    # ghost: stale heartbeat, nothing else -> off
    (h / "profiles/ghost").mkdir()
    _state_db(h / "profiles/ghost/state.db", hb=NOW - 7200)
    # a dotfile dir that must be ignored
    (h / "profiles/.tmp").mkdir()
    _kanban(h / "kanban/boards/gsp/kanban.db",
            tasks=[("T1", "Find embedded engineers", "agent:sourcer", "running", "high", "agent:chief", int(NOW - 5000), int(NOW - 4800), None, None, None, "R1", int(NOW - 20)),
                   ("T2", "Approve copy", "agent:editor", "blocked", "normal", "agent:chief", int(NOW - 900), None, None, "needs_human", None, None, None),
                   ("T3", "Done thing", "agent:chief", "done", "normal", "human", int(NOW - 90000), None, int(NOW - 80000), None, None, None, None)],
            runs=[("R1", "T1", "sourcer", "running", None, int(NOW - 4 * 3600), None, int(NOW - 20), 1, None)],
            events=[("T2", None, "blocked", "{}", int(NOW - 800)), ("T1", "R1", "started", "{}", int(NOW - 4800))])
    (h / "profiles/chief/cron").mkdir()
    (h / "profiles/chief/cron/jobs.json").write_text(json.dumps({"jobs": [
        {"id": "j1", "name": "morning", "schedule": {"display": "every day 07:00"}, "enabled": True, "last_status": "ok",
         "last_run_at": "2027-01-15T07:00:00+00:00", "next_run_at": "2027-01-16T07:00:00+00:00"}]}))
    return h


def test_discover_profiles(home):
    assert sources.discover_profiles(home) == ["default", "chief", "editor", "ghost", "sourcer"]


def test_states_without_config(home):
    s = Sensor(home=home)
    snap = s.poll(now=NOW)
    u = snap["units"]
    assert u["chief"]["state"] == "working" and u["chief"]["delegations"] == 2 and u["chief"]["model"] == "glm-5.3-flash"
    assert u["sourcer"]["state"] == "task" and u["sourcer"]["task"]["id"] == "T1" and u["sourcer"]["delegated_by"] == "chief"
    assert u["editor"]["state"] == "blocked" and u["editor"]["blocked"][0]["id"] == "T2"
    assert u["ghost"]["state"] == "off"
    assert u["default"]["state"] == "idle" and u["default"]["is_owner"]
    assert snap["totals"]["needs_you"] == 1
    assert snap["pipeline"] == {"running": 1, "blocked": 1, "done": 1}
    assert snap["groups"] == [{"id": "other", "label": "Fleet", "profiles": ["default", "chief", "editor", "ghost", "sourcer"]}]
    assert any(a["rule"] == "long-task" for a in u["sourcer"]["anomalies"])
    assert u["chief"]["cron"]["jobs"] == 1 and u["chief"]["cron"]["next_run_at"]


def test_config_groups_signals_and_hide(home):
    (home / "cockpit.yaml").write_text("""
title: GSP Floor
owner_profile: chief
owner_label: Sanjeev
spend_ceiling_usd: 25
hide_profiles: [ghost]
groups:
  - id: leadership
    label: Leadership
    profiles: [chief]
  - label: Recruiting Ops
    profiles: [sourcer, editor, nonexistent]
signals:
  - id: sync
    label: sync tick
    path: %s
    warn_after_s: 900
thresholds:
  long_task_s: 7200
""" % (home / "sync.log"))
    (home / "sync.log").write_text("x")
    s = Sensor(home=home)
    snap = s.poll(now=time.time())
    assert snap["title"] == "GSP Floor" and snap["owner"] == "chief"
    assert "ghost" not in snap["units"]
    assert [g["id"] for g in snap["groups"]] == ["leadership", "recruiting-ops", "other"]
    assert snap["groups"][1]["profiles"] == ["sourcer", "editor"]
    assert snap["groups"][2]["profiles"] == ["default"]
    assert snap["signals"][0]["ok"] is True
    assert s.config.thresholds.long_task_s == 7200
    assert snap["units"]["chief"]["is_owner"]


def test_transitions_feed_history_and_detail(home):
    s = Sensor(home=home)
    s.poll(now=NOW)
    # unblock editor
    c = sqlite3.connect(home / "kanban/boards/gsp/kanban.db")
    c.execute("update tasks set status='done' where id='T2'")
    c.execute("insert into task_events(task_id,run_id,kind,payload,created_at) values('T2',NULL,'completed','{}',?)", (int(NOW + 1),))
    c.commit(); c.close()
    changes = []
    s.on_change = changes.append
    snap = s.poll(now=NOW + 5)
    assert snap["units"]["editor"]["state"] == "idle"
    assert changes and changes[0]["changes"] == [{"profile": "editor", "from": "blocked", "to": "idle"}]
    kinds = [e["kind"] for e in s.feed()]
    assert "state" in kinds and "kanban" in kinds
    assert len(s.history(minutes=10 ** 6)) == 2
    d = s.unit_detail("chief")
    assert d["recent_sessions"][0]["id"] == "s1"
    assert s.unit_detail("nope") is None
    assert s.health()["units"] == 5


def test_rate_from_token_deltas(home):
    s = Sensor(home=home)
    s.poll(now=NOW)
    c = sqlite3.connect(home / "profiles/chief/state.db")
    c.execute("update sessions set output_tokens=output_tokens+3000, last_activity_at=?", (NOW + 30,))
    c.commit(); c.close()
    snap = s.poll(now=NOW + 30)
    assert snap["units"]["chief"]["tokens_per_min"] == 6000.0


def test_missing_everything_is_fine(tmp_path):
    s = Sensor(home=tmp_path / "empty")
    snap = s.poll()
    assert list(snap["units"]) == ["default"] and snap["units"]["default"]["state"] == "idle"
    assert snap["pipeline"] == {} and snap["boards"] == []


def test_parse_config_defaults():
    cfg = parse_config(None)
    assert cfg.title == "Hermes Cockpit" and cfg.groups == [] and cfg.allow_task_create is False
    assert load_config(Path("/nonexistent")).owner_profile == "default"
