"""The FastAPI router, exercised through TestClient against a synthetic home."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboard"))


@pytest.fixture
def client(tmp_path, monkeypatch):
    home = tmp_path / "h"
    (home / "profiles" / "p1").mkdir(parents=True)
    (home / "profiles" / "p1" / "config.yaml").write_text("model: x\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    sys.modules.pop("plugin_api", None)
    api = importlib.import_module("plugin_api")
    api._sensor = None
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/hermes-cockpit")
    c = TestClient(app)
    yield c
    api._sensor.stop()


def test_routes(client):
    base = "/api/plugins/hermes-cockpit"
    fleet = client.get(f"{base}/fleet").json()
    assert set(fleet["units"]) == {"default", "p1"} and fleet["mode"] == "live"
    assert client.get(f"{base}/health").json()["ok"] is True
    assert client.get(f"{base}/config").json()["title"] == "Hermes Cockpit"
    assert client.get(f"{base}/feed").json()["items"] == []
    assert "points" in client.get(f"{base}/history?minutes=5").json()
    assert client.get(f"{base}/unit/p1").status_code == 200
    assert client.get(f"{base}/unit/zzz").status_code == 404
    r = client.post(f"{base}/task", json={"title": "hello world", "assignee": "p1"})
    assert r.status_code == 403  # write disabled by default
