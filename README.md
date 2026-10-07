# hermes-cockpit

Mission control for a Hermes install. Every profile is a **unit** in a constellation around
your seat; **swimlanes** underneath show what ran when, and you can drag them to replay the
last hour. A right-hand drawer gives the selected unit's live steps and the controls that
matter (open chat, steer the current turn, interrupt, pause a cron job, hand it a card).

Works unchanged on a laptop with one profile and on a VPS with fifty: with no configuration
every profile becomes a unit in one group; a small `cockpit.yaml` adds departments, the owner
seat, a spend ceiling, thresholds and file-age signals.

```
┌ GSP Floor · live   10 NEEDS YOU   1 WORKING   0 SUBAGENTS   1.7K/min   $100 / $60   hb 37s ┐
│ all 51 · Leadership 1! · Operations 3! · Recruiting 1! · Engineering 3! …  board: blocked 24 │
│                         ·  ·  ·                                 ┃ chief · needs you · 2h     │
│                 ·     ⊙ blocked ring   ·                        ┃ [Open chat] [Copy summary] │
│              ·        ( you )             ·                     ┃ needs you: T-412 Approve…  │
│                 ·                       ·                       ┃ live steps: read_file …    │
│ Leadership ─────── Recruiting ─────── Engineering ──────────    ┃ cron · 3 jobs   ⏸ ⏸ ▶      │
│ ▁▁▃▃▃▅▅▅▅▃▁▁▁▁  ▁▁▁▁▁▁▃▃▃▃▁▁▁▁  ▁▁▃▃▃▃▃▃▅▅▅▅▅▁▁  -60m … now    ┃ FEED  12:04 blocked · #222 │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## What it reads (read-only)

The sensor runs inside the gateway and reads only files Hermes already keeps under
`$HERMES_HOME`: `state.db` per profile (sessions, turn leases, async delegations, gateway
heartbeats, usage), `kanban/boards/*/kanban.db` (tasks, runs, events), `profiles/*/cron/`
(definitions, executions), `profile.yaml`/`config.yaml` (model, display name). No shelling
out, no writes. The one optional write — creating a kanban card from the drawer — is off
until `allow_task_create: true` is set, and goes through Hermes' own `kanban_db.create_task`.

## State per unit

| state | meaning | how it is derived |
|---|---|---|
| `blocked` | needs the operator | a kanban card assigned to it is `blocked` |
| `failed` | something broke recently | a failed run or cron job inside `failed_window_s` |
| `task` | running a board task | a `task_runs` row is `running` under this profile |
| `working` | mid-turn | a turn lease is held, a session was active inside `working_window_s`, or a cron job is executing |
| `idle` | nothing moving | — |
| `off` | off duty | profile disabled, or heartbeat stale for 30 min and nothing moves |

Subagents/delegations ride on top as orbiting moons; delegation edges connect the card's
creator to its assignee with particles flowing along them. Anomalies (long task, silent
heartbeat, repeated identical tool calls) show as an amber dot and in the drawer.

## Install

The package has two halves; both default to **off** after install.

**Python half (on the machine running the gateway / `hermes serve`):**

```bash
hermes plugins install /path/to/hermes-cockpit     # or the git URL
# then add `hermes-cockpit` to plugins.enabled in $HERMES_HOME/config.yaml and restart the gateway
curl -s http://127.0.0.1:<port>/api/plugins/hermes-cockpit/health
```

**Desktop half (on the machine running the Hermes desktop app):**

Settings → Plugins → *Install from Git* with this repository, or copy `desktop/plugin.js` to
`~/.hermes/desktop-plugins/hermes-cockpit/plugin.js`. Enable it under Capabilities → Plugins.
A "Cockpit" entry appears in the sidebar; `mod+shift+k` opens it; a chip in the status bar
shows *needs you / working / spend* everywhere in the app.

If the desktop half is enabled but the python half is not, the page still works in
**RPC-only** mode (profiles and live sessions, no board/cost/cron) via the gateway's JSON-RPC.
If nothing is reachable it shows **demo** data and says so.

## Configure the backend: `$HERMES_HOME/cockpit.yaml`

See [`dev/cockpit.example.yaml`](dev/cockpit.example.yaml) — groups, owner seat, spend
ceiling, hidden profiles, file-age signals, thresholds. Hot-reloaded on change.

Display preferences (poll interval, lanes, density, reduced motion, demo data) live per laptop
under Settings → Plugins → Hermes Cockpit.

## Interactions

| where | action |
|---|---|
| constellation | hover: tooltip · click: select → drawer · double-click: open a chat with the unit |
| swimlanes | drag: replay the constellation at that time · double-click or Esc: back to live |
| mission bar | state chips filter · `/` focuses search · spend turns amber at 80 % of the ceiling, red above |
| group rail | click a department to dim the rest; counts show working↑ and blocked! |
| drawer | Open chat · Steer (text → `session.steer`) · Interrupt · pause/resume cron · hand a card · copy summary |
| palette | Open Cockpit · jump to the unit that needs me · toggle demo data |
| keybinds | `mod+shift+k` open · `mod+shift+l` lanes · `mod+shift+n` next unit that needs you |

## REST (mounted at `/api/plugins/hermes-cockpit/`)

`GET /health` · `GET /config` · `GET /fleet` · `GET /feed?since=&limit=` · `GET /history?minutes=` ·
`GET /unit/{profile}` · `POST /task` (403 unless `allow_task_create`). The sensor broadcasts
`plugin.hermes-cockpit.fleet.changed` on state transitions; the desktop half refetches on it
and otherwise polls (default 4 s).

## Develop

```bash
uv venv .venv && uv pip install -p .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest -q tests                      # sensor + API (synthetic HERMES_HOME)
npm ci && node tests/smoke-plugin.mjs                    # desktop half in jsdom with a mock SDK
.venv/bin/python dev/serve.py --port 8790 --config dev/cockpit.example.yaml   # real sensor + browser harness
```

The harness at `http://127.0.0.1:8790/` loads `desktop/plugin.js` with a browser-side mock of
the SDK against the real sensor, so the page can be reviewed with live data before it is
installed in the app. It is the dev path only; in the app the plugin loads natively.

## Design notes

- No JSX, three imports only, theme variables only, every timer/listener through `ctx` — the
  disk-plugin rules of the Hermes desktop SDK.
- Canvases size themselves from their container through `ResizeObserver` (attributes, not CSS).
- The sensor tolerates every missing file, locked DB and unknown schema: a bad read yields an
  empty result, never a dead picture. Poll cost on a 51-profile install is ~0.6 s.
- Reduced-motion mode keeps the information (position + colour) and drops the animation.
