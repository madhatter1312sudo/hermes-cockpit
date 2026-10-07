"""Configuration: ``$HERMES_HOME/cockpit.yaml`` (optional) over built-in defaults.

The plugin must work on any Hermes install with **no** config file: every profile under
``$HERMES_HOME/profiles/`` plus ``default`` becomes a unit in one group called *Fleet*.
A config file adds groups, labels, the owner's seat, thresholds and optional file signals.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:  # PyYAML ships with hermes-agent; keep the sensor importable without it.
    import yaml
except Exception:  # pragma: no cover - exercised only on a stripped install
    yaml = None


def hermes_home() -> Path:
    """``HERMES_HOME`` if set, else ``~/.hermes`` — mirrors ``hermes_constants.get_hermes_home``
    without importing it (the sensor must also run in tests outside the gateway)."""
    raw = os.environ.get("HERMES_HOME")
    return Path(raw).expanduser() if raw else Path(os.path.expanduser("~")) / ".hermes"


@dataclass
class Group:
    id: str
    label: str
    profiles: list[str] = field(default_factory=list)


@dataclass
class Signal:
    """A file whose age tells the operator something (``sync.log`` last tick, a heartbeat)."""

    id: str
    label: str
    path: str
    warn_after_s: int = 900
    kind: str = "file_age"  # the only kind today; kept explicit for forward compatibility


@dataclass
class Thresholds:
    working_window_s: int = 120      # session activity newer than this = working
    stale_heartbeat_s: int = 300     # gateway heartbeat older than this = off duty
    failed_window_s: int = 3600      # a failed run/cron inside this window = failed
    long_task_s: int = 3 * 3600      # a task running longer than this = anomaly
    repeat_tool_calls: int = 5       # same tool+path N times in a session = anomaly
    poll_interval_s: float = 3.0
    history_minutes: int = 60
    feed_size: int = 400


@dataclass
class CockpitConfig:
    title: str = "Hermes Cockpit"
    owner_profile: str = "default"
    owner_label: str = "you"
    spend_ceiling_usd: float | None = None
    groups: list[Group] = field(default_factory=list)
    other_group_label: str = "Other"
    hide_profiles: list[str] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)
    thresholds: Thresholds = field(default_factory=Thresholds)
    kanban_boards: list[str] | None = None   # None = every board found
    allow_task_create: bool = False          # POST /task is refused unless the operator opts in
    source_path: str | None = None           # where the config came from (for the UI)

    def group_of(self, profile: str) -> Group | None:
        for g in self.groups:
            if profile in g.profiles:
                return g
        return None

    def to_public(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "owner_profile": self.owner_profile,
            "owner_label": self.owner_label,
            "spend_ceiling_usd": self.spend_ceiling_usd,
            "groups": [{"id": g.id, "label": g.label, "profiles": list(g.profiles)} for g in self.groups],
            "other_group_label": self.other_group_label,
            "signals": [{"id": s.id, "label": s.label, "warn_after_s": s.warn_after_s} for s in self.signals],
            "thresholds": self.thresholds.__dict__,
            "allow_task_create": self.allow_task_create,
            "source_path": self.source_path,
        }


def _as_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return [str(x) for x in v]


def parse_config(data: dict[str, Any] | None, source_path: str | None = None) -> CockpitConfig:
    data = data or {}
    cfg = CockpitConfig(source_path=source_path)
    cfg.title = str(data.get("title") or cfg.title)
    cfg.owner_profile = str(data.get("owner_profile") or cfg.owner_profile)
    cfg.owner_label = str(data.get("owner_label") or cfg.owner_label)
    ceiling = data.get("spend_ceiling_usd")
    cfg.spend_ceiling_usd = float(ceiling) if ceiling is not None else None
    cfg.other_group_label = str(data.get("other_group_label") or cfg.other_group_label)
    cfg.hide_profiles = _as_list(data.get("hide_profiles"))
    cfg.allow_task_create = bool(data.get("allow_task_create", False))
    boards = data.get("kanban_boards")
    cfg.kanban_boards = _as_list(boards) if boards is not None else None
    for i, g in enumerate(data.get("groups") or []):
        if not isinstance(g, dict):
            continue
        gid = str(g.get("id") or g.get("label") or f"group-{i}").lower().replace(" ", "-")
        cfg.groups.append(Group(id=gid, label=str(g.get("label") or gid), profiles=_as_list(g.get("profiles"))))
    for i, s in enumerate(data.get("signals") or []):
        if not isinstance(s, dict) or not s.get("path"):
            continue
        cfg.signals.append(Signal(
            id=str(s.get("id") or f"signal-{i}"), label=str(s.get("label") or s.get("id") or s["path"]),
            path=str(s["path"]), warn_after_s=int(s.get("warn_after_s") or 900), kind=str(s.get("kind") or "file_age"),
        ))
    th = data.get("thresholds") or {}
    for k, v in th.items():
        if hasattr(cfg.thresholds, k):
            cur = getattr(cfg.thresholds, k)
            setattr(cfg.thresholds, k, type(cur)(v))
    return cfg


def config_path(home: Path | None = None) -> Path:
    return (home or hermes_home()) / "cockpit.yaml"


def load_config(home: Path | None = None) -> CockpitConfig:
    p = config_path(home)
    if not p.is_file():
        return parse_config(None, None)
    text = p.read_text(encoding="utf-8")
    if yaml is None:
        raise RuntimeError("cockpit.yaml present but PyYAML is not importable")
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{p}: top level must be a mapping")
    return parse_config(data, str(p))
