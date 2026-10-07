// hermes-cockpit — desktop half. Loaded uncompiled by the Hermes desktop app: no JSX, only
// `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve. Theme variables only.
//
// Data comes from three doors, tried in order and shown as a badge in the mission bar:
//   live  — the Python sensor (`ctx.rest('/fleet')`), pushed by `plugin.hermes-cockpit.fleet.changed`
//   rpc   — no sensor enabled: `profiles.list` + `session.active_list` per profile over JSON-RPC
//   demo  — nothing reachable: a synthetic fleet so the page is never blank
import { jsx, jsxs } from 'react/jsx-runtime'
import React from 'react'
import {
  host, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, PALETTE_AREA, KEYBINDS_AREA,
  useValue
} from '@hermes/plugin-sdk'

const { useState, useEffect, useRef, useCallback, useMemo } = React
// Keyed children: the jsx runtime takes `key` as the third argument, not inside props.
const jsxk = (type, props) => { const { key, ...rest } = props; return jsx(type, rest, key) }
const jsxsk = (type, props) => { const { key, ...rest } = props; return jsxs(type, rest, key) }
const ID = 'hermes-cockpit'
const PATH = '/cockpit'
const STATES = ['blocked', 'failed', 'task', 'working', 'idle', 'off']
const STATE_LABEL = { blocked: 'needs you', failed: 'failed', task: 'on task', working: 'working', idle: 'idle', off: 'off duty' }

// ── tiny store (nanostore-shaped so `useValue` from the SDK can read it) ─────────────────
function atom(initial) {
  let v = initial; const subs = new Set()
  return {
    get: () => v,
    set: (n) => { if (n === v) return; v = n; subs.forEach(f => { try { f(v) } catch (e) { /* listener error must not break others */ } }) },
    subscribe: (f) => { subs.add(f); f(v); return () => subs.delete(f) },
    listen: (f) => { subs.add(f); return () => subs.delete(f) }
  }
}
function useAtom(a) {
  // Prefer the SDK hook (shares the app's nanostore semantics); fall back to a local subscription.
  if (typeof useValue === 'function') { try { return useValue(a) } catch (e) { /* not a nanostore host */ } }
  const [v, setV] = useState(a.get()); useEffect(() => a.listen(setV), [a]); return v
}

const DEFAULT_PREFS = {
  pollMs: 4000, showLanes: true, laneMinutes: 60, density: 'comfortable', particles: true,
  reducedMotion: false, demo: false, showIdle: true, laneBy: 'group', focusOnNeedsYou: true
}
const $prefs = atom(DEFAULT_PREFS)
const $snap = atom(null)       // fleet snapshot (sensor shape, also produced by rpc/demo adapters)
const $feed = atom([])         // [{seq, ts, kind, profile, text}]
const $history = atom([])      // [{ts, states:{p:state}, tpm:{p:n}}]
const $mode = atom('connecting')  // connecting | live | rpc | demo | error
const $error = atom(null)
const $selected = atom(null)   // profile name
const $filter = atom({ q: '', states: new Set(STATES), group: null })
const $replayT = atom(null)    // epoch seconds when scrubbing; null = live
const $notice = atom(null)     // {text, kind}

function fmtAge(s) { if (s == null) return '—'; if (s < 60) return `${Math.round(s)}s`; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${(s / 3600).toFixed(1)}h`; return `${Math.round(s / 86400)}d` }
function fmtTok(n) { n = Number(n || 0); if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`; return String(Math.round(n)) }
function fmtUsd(n) { return n == null ? '—' : `$${Number(n).toFixed(2)}` }
function fmtClock(ts) { try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch (e) { return '' } }
function notice(text, kind = 'info') { $notice.set({ text, kind, at: Date.now() }) }

// ── colours: semantic state colours come from theme variables with sane fallbacks ──────
const VAR_FALLBACK = { // VAR_FALLBACK: only used when a theme variable is missing (never in the app)
  '--ui-text': '#e6e6e6', '--ui-text-secondary': '#9aa0a6', '--ui-accent': '#7aa2ff', '--ui-border': 'rgba(127,127,127,.25)', // VAR_FALLBACK
  '--ui-success': '#38c172', '--ui-warning': '#f0b429', '--ui-danger': '#ef4e4e', '--ui-info': '#3db8f5', '--ui-surface': 'rgba(127,127,127,.08)' // VAR_FALLBACK
}
function cssVar(el, name) {
  try { const v = getComputedStyle(el).getPropertyValue(name).trim(); if (v) return v } catch (e) { /* no DOM */ }
  return VAR_FALLBACK[name] || '#888'
}
function palette(el) {
  return {
    text: cssVar(el, '--ui-text'), muted: cssVar(el, '--ui-text-secondary'), accent: cssVar(el, '--ui-accent'), border: cssVar(el, '--ui-border'),
    blocked: cssVar(el, '--ui-danger'), failed: cssVar(el, '--ui-warning'), task: cssVar(el, '--ui-accent'), working: cssVar(el, '--ui-success'),
    idle: cssVar(el, '--ui-text-secondary'), off: cssVar(el, '--ui-border'), info: cssVar(el, '--ui-info')
  }
}

// ── data adapters ───────────────────────────────────────────────────────────────────────
function unitsOf(snap) { return snap ? Object.values(snap.units || {}) : [] }

async function fetchLive(ctx) {
  const snap = await ctx.rest('/fleet')
  if (!snap || !snap.units) throw new Error('sensor returned no fleet')
  return snap
}
async function fetchFeedLive(ctx, since) { const r = await ctx.rest(`/feed?since=${since}&limit=200`); return r && r.items ? r.items : [] }
async function fetchHistoryLive(ctx, minutes) { const r = await ctx.rest(`/history?minutes=${minutes}`); return r && r.points ? r.points : [] }

// RPC-only picture: enough to show who exists and who is mid-turn. No kanban, no cost.
async function fetchRpc() {
  const res = await host.request('profiles.list', {})
  const rows = Array.isArray(res) ? res : (res && (res.profiles || res.items || res.rows)) || []
  const now = Date.now() / 1000
  const units = {}
  const names = rows.map(r => (typeof r === 'string' ? r : (r.name || r.id))).filter(Boolean)
  if (!names.includes('default')) names.unshift('default')
  const limit = 6; let i = 0
  async function worker() {
    while (i < names.length) {
      const name = names[i++]; const row = rows.find(r => (r.name || r.id) === name) || {}
      let sessions = []
      try {
        const r = await host.requestProfile(name, 'session.active_list', {})
        sessions = (r && r.sessions) || []
      } catch (e) { /* profile has no backend right now */ }
      const live = sessions.filter(s => s.status && /running|streaming|working|busy|active/i.test(String(s.status)))
      const latest = sessions.slice().sort((a, b) => (b.last_active || 0) - (a.last_active || 0))[0]
      units[name] = {
        profile: name, group: 'other', state: live.length ? 'working' : 'idle', since: now, is_owner: name === 'default',
        display_name: row.display_name || '', description: row.description || '', model: row.model || (latest && latest.model) || null,
        heartbeat_age_s: null, lease_count: live.length, active_sessions: live.length, delegations: 0, tokens_today: 0, cost_today_usd: 0,
        sessions_today: sessions.length, tokens_per_min: 0, blocked: [], failed: [], anomalies: [], cron: {}, task: null,
        latest_session: latest ? { id: latest.id, title: latest.title || latest.preview || '', model: latest.model, last_activity_at: latest.last_active } : null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker))
  return {
    rev: 0, ts: now, mode: 'rpc', title: 'Hermes Cockpit', owner: 'default', groups: [{ id: 'other', label: 'Fleet', profiles: names }],
    units, totals: totalsOf(units), pipeline: {}, boards: [], signals: [], gateway: {}, spend_ceiling_usd: null
  }
}
function totalsOf(units) {
  const list = Object.values(units); const by = {}
  STATES.forEach(s => { by[s] = list.filter(u => u.state === s).length })
  return {
    units: list.length, by_state: by, needs_you: by.blocked, delegations: list.reduce((a, u) => a + (u.delegations || 0), 0),
    tokens_today: list.reduce((a, u) => a + (u.tokens_today || 0), 0), cost_today_usd: list.reduce((a, u) => a + (u.cost_today_usd || 0), 0),
    tokens_per_min: list.reduce((a, u) => a + (u.tokens_per_min || 0), 0)
  }
}

// Demo fleet: deterministic, slowly evolving, so the page is never blank (and screenshots are stable).
const DEMO_GROUPS = [
  { id: 'leadership', label: 'Leadership', profiles: ['chief', 'coordinator'] },
  { id: 'recruiting', label: 'Recruiting', profiles: ['sourcer', 'screener', 'outreach', 'market-analyst'] },
  { id: 'content', label: 'Content', profiles: ['editor', 'content-creator', 'copy-engineer'] },
  { id: 'engineering', label: 'Engineering', profiles: ['engineering-lead', 'plugin-engineer', 'tech-planner'] },
  { id: 'ops', label: 'Ops', profiles: ['backoffice', 'finance', 'assistant'] }
]
let demoSeed = 7
function rnd() { demoSeed = (demoSeed * 1103515245 + 12345) & 0x7fffffff; return demoSeed / 0x7fffffff }
function demoSnap(prev) {
  const now = Date.now() / 1000
  const units = prev ? JSON.parse(JSON.stringify(prev.units)) : {}
  const all = ['default'].concat(DEMO_GROUPS.flatMap(g => g.profiles))
  all.forEach((p, i) => {
    if (!units[p]) units[p] = { profile: p, group: (DEMO_GROUPS.find(g => g.profiles.includes(p)) || { id: 'other' }).id, state: i % 3 === 0 ? 'working' : 'idle', since: now - rnd() * 3000, is_owner: p === 'default', display_name: '', description: '', model: ['glm-5.3-flash', 'deepseek-v4-flash', 'claude-fable-5-1'][i % 3], heartbeat_age_s: 4, lease_count: 0, active_sessions: 0, delegations: 0, tokens_today: Math.round(rnd() * 400000), cost_today_usd: rnd() * 6, sessions_today: 1 + Math.round(rnd() * 20), tokens_per_min: 0, blocked: [], failed: [], anomalies: [], cron: { jobs: Math.round(rnd() * 4), running: 0, errors_recent: 0, paused: 0 }, task: null, latest_session: { id: 's' + i, title: ['Morning brief', 'Source embedded engineers', 'Draft outreach', 'Review PR #5', 'Reconcile invoices'][i % 5], model: null, last_activity_at: now - rnd() * 600, tool_calls: Math.round(rnd() * 30), tokens: Math.round(rnd() * 50000) } }
    const u = units[p]; const r = rnd()
    if (u.state === 'idle' && r < 0.04) { u.state = 'working'; u.since = now }
    else if (u.state === 'working' && r < 0.03) { u.state = 'task'; u.since = now; const by = DEMO_GROUPS[0].profiles[0]; u.task = { id: 'T' + Math.round(rnd() * 900), title: u.latest_session.title, started_at: now, created_by: 'agent:' + by, board: 'demo' }; u.delegated_by = by }
    else if ((u.state === 'working' || u.state === 'task') && r > 0.975) { u.state = 'blocked'; u.since = now; u.blocked = [{ id: 'T' + Math.round(rnd() * 900), title: 'Approve: ' + u.latest_session.title, block_kind: 'needs_human', created_at: now }] }
    else if (u.state === 'blocked' && r > 0.95) { u.state = 'idle'; u.since = now; u.blocked = []; u.task = null; u.delegated_by = null }
    else if ((u.state === 'working' || u.state === 'task') && r > 0.93) { u.state = 'idle'; u.since = now; u.task = null; u.delegated_by = null }
    if (u.state === 'working' || u.state === 'task') { const rate = 800 + rnd() * 4000; u.tokens_per_min = Math.round(rate); u.tokens_today += Math.round(rate / 15); u.cost_today_usd += rate / 15 * 0.0000025 }
    else u.tokens_per_min = Math.max(0, Math.round(u.tokens_per_min * 0.6))
    u.delegations = u.state === 'task' ? 1 + Math.round(rnd() * 2) : 0
  })
  return { rev: (prev ? prev.rev : 0) + 1, ts: now, mode: 'demo', title: 'Hermes Cockpit · demo', owner: 'default', spend_ceiling_usd: 60, groups: DEMO_GROUPS.concat([{ id: 'other', label: 'You', profiles: ['default'] }]), units, totals: totalsOf(units), pipeline: { todo: 4, ready: 2, running: 3, blocked: 2, review: 1, done: 41 }, boards: ['demo'], signals: [{ id: 'sync', label: 'sync tick', age_s: 120, ok: true, warn_after_s: 900 }], gateway: { heartbeat_age_s: 3 } }
}

// Diff two snapshots into feed rows (used by the rpc/demo adapters; live has a server feed).
let localSeq = 0
function diffToFeed(prev, next) {
  if (!prev) return []
  const out = []
  Object.values(next.units).forEach(u => { const p = prev.units[u.profile]; if (p && p.state !== u.state) out.push({ seq: ++localSeq, ts: next.ts, kind: 'state', profile: u.profile, text: `${u.profile}: ${STATE_LABEL[p.state]} → ${STATE_LABEL[u.state]}` }) })
  return out
}

// ── the poller: one per plugin lifetime, owned by register() ────────────────────────────
function startPoller(ctx) {
  let stopped = false, timer = null, feedSeq = 0, consecutiveFail = 0, backoff = 1
  const mark = (m) => { if ($mode.get() !== m) $mode.set(m) }
  async function tick() {
    if (stopped) return
    const prefs = $prefs.get(); const prev = $snap.get()
    try {
      if (prefs.demo) {
        const s = demoSnap(prev && prev.mode === 'demo' ? prev : null); apply(s, diffToFeed(prev && prev.mode === 'demo' ? prev : null, s)); mark('demo')
      } else {
        let snap = null
        try {
          snap = await fetchLive(ctx); mark('live')
          const items = await fetchFeedLive(ctx, feedSeq)
          if (items.length) { feedSeq = items[items.length - 1].seq; $feed.set($feed.get().concat(items).slice(-500)) }
          if ($history.get().length === 0 || (snap.rev % 15) === 0) { const pts = await fetchHistoryLive(ctx, prefs.laneMinutes); if (pts.length) $history.set(pts) }
          else pushHistory(snap)
        } catch (e) {
          // Sensor not enabled (404) or gateway without the python half → RPC door.
          snap = await fetchRpc(); mark('rpc'); apply(snap, diffToFeed(prev, snap)); snap = null
        }
        if (snap) { $snap.set(snap); $error.set(null) }
      }
      consecutiveFail = 0; backoff = 1
    } catch (e) {
      consecutiveFail++; $error.set(String(e && e.message || e))
      if (consecutiveFail >= 3) { mark('demo'); const s = demoSnap(prev && prev.mode === 'demo' ? prev : null); apply(s, []); backoff = Math.min(backoff * 2, 8) }
    }
    timer = ctx.setTimeout(tick, Math.max(1500, $prefs.get().pollMs) * backoff)
  }
  function apply(snap, feedRows) { $snap.set(snap); if (feedRows.length) $feed.set($feed.get().concat(feedRows).slice(-500)); pushHistory(snap) }
  function pushHistory(snap) {
    const states = {}, tpm = {}; unitsOf(snap).forEach(u => { states[u.profile] = u.state; if (u.tokens_per_min) tpm[u.profile] = u.tokens_per_min })
    const h = $history.get().concat([{ ts: snap.ts, states, tpm }]); const cutoff = snap.ts - $prefs.get().laneMinutes * 60 - 60
    $history.set(h.filter(p => p.ts >= cutoff))
  }
  // Push from the sensor → fetch now (no faster than once per second).
  let lastPush = 0
  const offEvt = host.onEvent ? host.onEvent(`plugin.${ID}.fleet.changed`, (payload) => {
    const now = Date.now(); if (now - lastPush < 1000) return; lastPush = now
    if (payload && payload.needs_you > 0 && $prefs.get().focusOnNeedsYou) notice(`${payload.needs_you} unit${payload.needs_you > 1 ? 's' : ''} need${payload.needs_you > 1 ? '' : 's'} you`, 'warn')
    if (timer) { try { timer() } catch (e) { /* already fired */ } }
    tick()
  }) : null
  tick()
  return () => { stopped = true; if (timer) { try { timer() } catch (e) { /* ok */ } } if (typeof offEvt === 'function') offEvt() }
}

// ── actions (every write goes through Hermes' own RPC/REST, never a shell) ───────────────
const actions = {
  openChat(profile) { try { host.newChat(profile === 'default' ? null : profile) } catch (e) { notice(`open chat failed: ${e.message || e}`, 'error') } },
  async steer(profile, sessionId, text) {
    if (!sessionId || !text) return
    try { await host.requestProfile(profile, 'session.steer', { session_id: sessionId, text }); notice(`steered ${profile}`) }
    catch (e) { notice(`steer failed: ${e.message || e}`, 'error') }
  },
  async interrupt(profile, sessionId) {
    if (!sessionId) return
    try { await host.requestProfile(profile, 'session.interrupt', { session_id: sessionId }); notice(`interrupted ${profile}`) }
    catch (e) { notice(`interrupt failed: ${e.message || e}`, 'error') }
  },
  async cron(profile, jobId, action) {
    try { await host.requestProfile(profile, 'cron.manage', { action, job_id: jobId }); notice(`cron ${action}: ${jobId}`) }
    catch (e) { notice(`cron ${action} failed: ${e.message || e}`, 'error') }
  },
  async createTask(ctx, assignee, title, description) {
    try { const r = await ctx.rest('/task', { method: 'POST', body: { assignee, title, description } }); notice(`card ${r.task_id} → ${assignee}`); return r }
    catch (e) { notice(`task refused: ${e.message || e}`, 'error'); return null }
  },
  copy(text) { try { navigator.clipboard.writeText(text); notice('copied') } catch (e) { notice('clipboard unavailable', 'error') } }
}

// ── constellation canvas ────────────────────────────────────────────────────────────────
function layout(snap, w, h, showIdle) {
  // Owner at the centre, one arc per group, units along the arc; blocked units pull inward.
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.40, inner = Math.min(w, h) * 0.17
  const pos = {}
  const groups = (snap.groups || []).filter(g => g.profiles.some(p => p !== snap.owner))
  const total = groups.reduce((a, g) => a + Math.max(1, g.profiles.filter(p => p !== snap.owner && (showIdle || (snap.units[p] && snap.units[p].state !== 'idle' && snap.units[p].state !== 'off'))).length), 0) || 1
  let a0 = -Math.PI / 2
  const arcs = []
  groups.forEach(g => {
    const members = g.profiles.filter(p => p !== snap.owner && snap.units[p] && (showIdle || (snap.units[p].state !== 'idle' && snap.units[p].state !== 'off')))
    const span = (Math.max(1, members.length) / total) * Math.PI * 2
    arcs.push({ id: g.id, label: g.label, a0, a1: a0 + span, n: members.length })
    members.forEach((p, i) => {
      const u = snap.units[p]
      const a = a0 + span * ((i + 0.5) / Math.max(1, members.length))
      const r = u.state === 'blocked' ? inner : (u.state === 'failed' ? inner * 1.45 : (u.state === 'task' || u.state === 'working' ? R * 0.82 : R))
      pos[p] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a, r }
    })
    a0 += span
  })
  pos[snap.owner] = { x: cx, y: cy, a: 0, r: 0 }
  return { pos, arcs, cx, cy, R, inner }
}

function Constellation({ ctx, onPick }) {
  const ref = useRef(null); const wrap = useRef(null)
  const snap = useAtom($snap); const prefs = useAtom($prefs); const selected = useAtom($selected); const filter = useAtom($filter); const replayT = useAtom($replayT)
  const hist = useAtom($history)
  const anim = useRef({ particles: [], smooth: {}, hover: null, t: 0 })
  // Resize: set width/height ATTRIBUTES from the container (hard rule 5).
  useEffect(() => {
    const el = wrap.current, c = ref.current; if (!el || !c) return
    const fit = () => { const r = el.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr)); c.style.width = r.width + 'px'; c.style.height = r.height + 'px' }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect()
  }, [])
  // Draw loop
  useEffect(() => {
    const c = ref.current; if (!c) return
    let raf = 0, last = performance.now(), alive = true
    const draw = (now) => {
      if (!alive) return
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      const A = anim.current; A.t += dt
      const ctx2 = c.getContext('2d'); if (!ctx2) return
      const dpr = Math.min(2, window.devicePixelRatio || 1); const w = c.width / dpr, h = c.height / dpr
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); ctx2.clearRect(0, 0, w, h)
      const s = $snap.get(); if (!s) { raf = requestAnimationFrame(draw); return }
      // Replay: substitute historical states when scrubbing.
      const rt = $replayT.get(); let view = s
      if (rt != null) { const pt = nearest($history.get(), rt); if (pt) { view = { ...s, units: {} }; Object.values(s.units).forEach(u => { view.units[u.profile] = { ...u, state: pt.states[u.profile] || 'off', tokens_per_min: (pt.tpm || {})[u.profile] || 0 } }) } }
      const P = palette(c); const pf = $prefs.get(); const f = $filter.get()
      const L = layout(view, w, h, pf.showIdle)
      const motion = pf.reducedMotion ? 0 : 1
      // group arcs + labels
      ctx2.lineWidth = 1; ctx2.strokeStyle = P.border; ctx2.font = '11px system-ui, sans-serif'; ctx2.fillStyle = P.muted
      L.arcs.forEach(g => {
        ctx2.beginPath(); ctx2.arc(L.cx, L.cy, L.R + 26, g.a0 + 0.03, g.a1 - 0.03); ctx2.stroke()
        const am = (g.a0 + g.a1) / 2; const lx = L.cx + Math.cos(am) * (L.R + 44), ly = L.cy + Math.sin(am) * (L.R + 44)
        ctx2.textAlign = Math.cos(am) > 0.3 ? 'left' : (Math.cos(am) < -0.3 ? 'right' : 'center'); ctx2.globalAlpha = f.group && f.group !== g.id ? 0.35 : 1
        ctx2.fillText(`${g.label.toUpperCase()}  ${g.n}`, lx, ly + 4); ctx2.globalAlpha = 1
      })
      // inner ring = "needs you"
      ctx2.setLineDash([3, 5]); ctx2.strokeStyle = P.blocked; ctx2.globalAlpha = 0.35; ctx2.beginPath(); ctx2.arc(L.cx, L.cy, L.inner, 0, Math.PI * 2); ctx2.stroke(); ctx2.setLineDash([]); ctx2.globalAlpha = 1
      // smooth positions
      Object.keys(L.pos).forEach(p => { const tgt = L.pos[p]; const sm = A.smooth[p] || (A.smooth[p] = { x: tgt.x, y: tgt.y }); const k = motion ? Math.min(1, dt * 4) : 1; sm.x += (tgt.x - sm.x) * k; sm.y += (tgt.y - sm.y) * k })
      // edges (delegation) + particles
      const units = Object.values(view.units)
      units.forEach(u => {
        const from = u.delegated_by || (u.delegations > 0 && u.profile !== view.owner ? null : null)
        if (!from || !A.smooth[from] || !A.smooth[u.profile]) return
        const a = A.smooth[from], b = A.smooth[u.profile]
        ctx2.strokeStyle = P.accent; ctx2.globalAlpha = 0.35; ctx2.lineWidth = 1.2; ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y); ctx2.stroke(); ctx2.globalAlpha = 1
        if (pf.particles && motion && Math.random() < dt * 3) A.particles.push({ from, to: u.profile, t: 0 })
      })
      A.particles = A.particles.filter(pt => { pt.t += dt * 0.9; const a = A.smooth[pt.from], b = A.smooth[pt.to]; if (!a || !b || pt.t > 1) return false; const x = a.x + (b.x - a.x) * pt.t, y = a.y + (b.y - a.y) * pt.t; ctx2.fillStyle = P.accent; ctx2.globalAlpha = 0.9 * (1 - Math.abs(pt.t - 0.5) * 0.6); ctx2.beginPath(); ctx2.arc(x, y, 2.2, 0, Math.PI * 2); ctx2.fill(); ctx2.globalAlpha = 1; return true })
      // orbiting moons = subagents / delegations
      units.forEach(u => {
        const sm = A.smooth[u.profile]; if (!sm || !u.delegations) return
        for (let i = 0; i < Math.min(5, u.delegations); i++) { const ang = A.t * 1.4 * motion + i * (Math.PI * 2 / Math.min(5, u.delegations)); ctx2.fillStyle = P.accent; ctx2.globalAlpha = 0.8; ctx2.beginPath(); ctx2.arc(sm.x + Math.cos(ang) * 17, sm.y + Math.sin(ang) * 17, 2, 0, Math.PI * 2); ctx2.fill(); ctx2.globalAlpha = 1 }
      })
      // nodes
      const q = f.q.toLowerCase()
      units.forEach(u => {
        const sm = A.smooth[u.profile]; if (!sm) return
        const match = (!q || u.profile.includes(q) || (u.display_name || '').toLowerCase().includes(q)) && f.states.has(u.state) && (!f.group || f.group === u.group || u.profile === view.owner)
        const col = P[u.state] || P.idle
        const rate = Math.min(1, (u.tokens_per_min || 0) / 4000)
        const base = u.profile === view.owner ? 16 : (pf.density === 'compact' ? 7 : 9)
        const breathe = (u.state === 'working' || u.state === 'task') ? 1 + Math.sin(A.t * (2 + rate * 4) * motion) * (0.08 + rate * 0.18) : 1
        const r = base * breathe
        ctx2.globalAlpha = match ? 1 : 0.18
        if (u.state === 'blocked') { const flash = 0.5 + 0.5 * Math.sin(A.t * 5 * motion); ctx2.fillStyle = col; ctx2.globalAlpha *= 0.25 + flash * 0.3; ctx2.beginPath(); ctx2.arc(sm.x, sm.y, r + 8 + flash * 5, 0, Math.PI * 2); ctx2.fill(); ctx2.globalAlpha = match ? 1 : 0.18 }
        if (u.state === 'working' || u.state === 'task') { ctx2.fillStyle = col; ctx2.globalAlpha *= 0.18; ctx2.beginPath(); ctx2.arc(sm.x, sm.y, r + 5 + rate * 8, 0, Math.PI * 2); ctx2.fill(); ctx2.globalAlpha = match ? 1 : 0.18 }
        ctx2.fillStyle = col; ctx2.beginPath(); ctx2.arc(sm.x, sm.y, r, 0, Math.PI * 2); ctx2.fill()
        if (u.state === 'off') { ctx2.strokeStyle = P.muted; ctx2.lineWidth = 1; ctx2.stroke() }
        if (u.profile === view.owner) { ctx2.strokeStyle = P.text; ctx2.lineWidth = 1.5; ctx2.beginPath(); ctx2.arc(sm.x, sm.y, r + 4, 0, Math.PI * 2); ctx2.stroke() }
        if ((u.anomalies || []).length) { ctx2.fillStyle = P.failed; ctx2.beginPath(); ctx2.arc(sm.x + r * 0.8, sm.y - r * 0.8, 3.2, 0, Math.PI * 2); ctx2.fill() }
        if (selected === u.profile || A.hover === u.profile) { ctx2.strokeStyle = P.text; ctx2.lineWidth = 1; ctx2.setLineDash([2, 3]); ctx2.beginPath(); ctx2.arc(sm.x, sm.y, r + 9, 0, Math.PI * 2); ctx2.stroke(); ctx2.setLineDash([]) }
        // label
        ctx2.fillStyle = P.text; ctx2.font = `${u.profile === view.owner ? 12 : 11}px system-ui, sans-serif`; ctx2.textAlign = 'center'
        const label = u.profile === view.owner ? (u.display_name || u.profile) : u.profile
        if (pf.density !== 'compact' || u.state !== 'idle' || selected === u.profile) ctx2.fillText(label, sm.x, sm.y + r + 13)
        if ((u.state === 'working' || u.state === 'task') && u.tokens_per_min) { ctx2.fillStyle = P.muted; ctx2.font = '10px ui-monospace, monospace'; ctx2.fillText(`${fmtTok(u.tokens_per_min)}/min`, sm.x, sm.y + r + 25) }
        ctx2.globalAlpha = 1
      })
      // hover tooltip
      if (A.hover && view.units[A.hover] && A.smooth[A.hover]) {
        const u = view.units[A.hover], sm = A.smooth[A.hover]
        const lines = [`${u.profile} · ${STATE_LABEL[u.state]}${u.since ? ' · ' + fmtAge(view.ts - u.since) : ''}`, u.task ? `task: ${u.task.title}` : (u.latest_session && u.latest_session.title ? `last: ${u.latest_session.title}` : ''), u.model ? `model: ${u.model}` : '', u.cost_today_usd ? `today: ${fmtTok(u.tokens_today)} tok · ${fmtUsd(u.cost_today_usd)}` : ''].filter(Boolean)
        ctx2.font = '11px system-ui, sans-serif'; const tw = Math.max(...lines.map(l => ctx2.measureText(l).width)) + 16; const th = lines.length * 15 + 10
        const tx = Math.min(w - tw - 4, Math.max(4, sm.x + 14)), ty = Math.max(4, sm.y - th - 8)
        ctx2.fillStyle = P.border; ctx2.fillRect(tx, ty, tw, th); ctx2.strokeStyle = P.muted; ctx2.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1)
        ctx2.fillStyle = P.text; ctx2.textAlign = 'left'; lines.forEach((l, i) => ctx2.fillText(l, tx + 8, ty + 16 + i * 15))
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [selected])
  const hit = (ev) => {
    const c = ref.current; if (!c) return null; const r = c.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top
    const A = anim.current; let best = null, bd = 18 * 18
    Object.keys(A.smooth).forEach(p => { const sm = A.smooth[p]; const d = (sm.x - x) ** 2 + (sm.y - y) ** 2; if (d < bd) { bd = d; best = p } })
    return best
  }
  return jsx('div', { ref: wrap, className: 'ck-canvas-wrap', style: { position: 'relative', flex: 1, minHeight: 240 }, children:
    jsx('canvas', { ref, 'aria-label': 'Fleet constellation', role: 'img', style: { display: 'block', cursor: 'crosshair' },
      onMouseMove: (e) => { anim.current.hover = hit(e) }, onMouseLeave: () => { anim.current.hover = null },
      onClick: (e) => { const p = hit(e); $selected.set(p); if (p && onPick) onPick(p) },
      onDoubleClick: (e) => { const p = hit(e); if (p) actions.openChat(p) } })
  })
}
function nearest(hist, t) { let best = null, bd = Infinity; for (const p of hist) { const d = Math.abs(p.ts - t); if (d < bd) { bd = d; best = p } } return best }

// ── swimlanes (history strip with replay scrubber) ──────────────────────────────────────
function Swimlanes() {
  const ref = useRef(null); const wrap = useRef(null)
  const snap = useAtom($snap); const hist = useAtom($history); const prefs = useAtom($prefs); const replayT = useAtom($replayT); const selected = useAtom($selected)
  const rows = useMemo(() => {
    if (!snap) return []
    if (prefs.laneBy === 'unit') return unitsOf(snap).filter(u => prefs.showIdle || u.state !== 'idle').map(u => ({ id: u.profile, label: u.profile, members: [u.profile] }))
    return (snap.groups || []).map(g => ({ id: g.id, label: g.label, members: g.profiles }))
  }, [snap, prefs.laneBy, prefs.showIdle])
  useEffect(() => {
    const el = wrap.current, c = ref.current; if (!el || !c) return
    const fit = () => { const r = el.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr)); c.style.width = r.width + 'px'; c.style.height = r.height + 'px'; paint() }
    const paint = () => {
      const ctx2 = c.getContext('2d'); if (!ctx2 || !snap) return
      const dpr = Math.min(2, window.devicePixelRatio || 1); const w = c.width / dpr, h = c.height / dpr
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); ctx2.clearRect(0, 0, w, h)
      const P = palette(c); const now = snap.ts; const span = prefs.laneMinutes * 60; const x0 = 110, x1 = w - 8
      const X = (t) => x0 + ((t - (now - span)) / span) * (x1 - x0)
      const rowH = Math.max(14, Math.min(26, (h - 18) / Math.max(1, rows.length)))
      ctx2.font = '11px system-ui, sans-serif'
      rows.forEach((row, i) => {
        const y = 4 + i * rowH
        ctx2.fillStyle = P.muted; ctx2.textAlign = 'right'; ctx2.fillText(row.label.slice(0, 16), x0 - 8, y + rowH * 0.65)
        ctx2.fillStyle = P.border; ctx2.fillRect(x0, y + rowH / 2, x1 - x0, 1)
        // per member: draw segments for non-idle states from consecutive history points
        row.members.forEach((p, j) => {
          const lanes = Math.max(1, row.members.length); const sub = (rowH - 6) / lanes; const yy = y + 3 + j * sub
          let seg = null
          const flush = (endT) => { if (!seg) return; ctx2.fillStyle = P[seg.state] || P.idle; ctx2.globalAlpha = selected && selected !== p ? 0.35 : 0.9; ctx2.fillRect(Math.max(x0, X(seg.t0)), yy, Math.max(1.5, X(endT) - X(seg.t0)), Math.max(1.5, sub - 1)); ctx2.globalAlpha = 1; seg = null }
          hist.forEach((pt, k) => {
            const st = pt.states[p]; const live = st && st !== 'idle' && st !== 'off'
            if (seg && (!live || seg.state !== st)) flush(pt.ts)
            if (live && !seg) seg = { state: st, t0: pt.ts }
            if (k === hist.length - 1 && seg) flush(now)
          })
        })
      })
      // time ticks
      ctx2.fillStyle = P.muted; ctx2.textAlign = 'center'; ctx2.font = '10px ui-monospace, monospace'
      for (let m = 0; m <= prefs.laneMinutes; m += Math.max(5, Math.round(prefs.laneMinutes / 6))) { const x = X(now - m * 60); ctx2.fillRect(x, h - 14, 1, 4); ctx2.fillText(m === 0 ? 'now' : `-${m}m`, x, h - 2) }
      if (replayT != null) { const x = X(replayT); ctx2.fillStyle = P.text; ctx2.fillRect(x, 0, 1.5, h - 16); ctx2.textAlign = 'left'; ctx2.fillText(fmtClock(replayT), Math.min(x + 4, w - 70), 10) }
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect()
  }, [snap, hist, rows, prefs.laneMinutes, replayT, selected])
  const scrub = (e, release) => {
    const c = ref.current; if (!c || !snap) return; const r = c.getBoundingClientRect(); const x = e.clientX - r.left; const x0 = 110, x1 = r.width - 8
    if (release || x >= x1 - 6) { $replayT.set(null); return }
    const frac = Math.max(0, Math.min(1, (x - x0) / (x1 - x0))); $replayT.set(snap.ts - prefs.laneMinutes * 60 * (1 - frac))
  }
  const drag = useRef(false)
  return jsx('div', { ref: wrap, className: 'ck-lanes', style: { height: Math.max(90, Math.min(220, 20 + rows.length * 22)), position: 'relative', borderTop: '1px solid var(--ui-border)' }, children:
    jsx('canvas', { ref, 'aria-label': 'Swimlanes', role: 'img', style: { display: 'block', cursor: 'ew-resize' },
      onMouseDown: (e) => { drag.current = true; scrub(e) }, onMouseMove: (e) => { if (drag.current) scrub(e) },
      onMouseUp: (e) => { drag.current = false }, onMouseLeave: () => { drag.current = false }, onDoubleClick: () => $replayT.set(null) }) })
}

// ── mission bar, rail, drawer, feed ─────────────────────────────────────────────────────
const S = {
  bar: { display: 'flex', alignItems: 'center', gap: 14, padding: '8px 12px', borderBottom: '1px solid var(--ui-border)', fontSize: 12, color: 'var(--ui-text-secondary)', flexWrap: 'wrap' },
  chip: (active) => ({ padding: '2px 8px', borderRadius: 999, border: '1px solid var(--ui-border)', cursor: 'pointer', background: active ? 'var(--ui-accent)' : 'transparent', color: active ? 'var(--ui-text-on-accent, #000)' : 'inherit', fontSize: 11 }),
  kpi: { display: 'flex', flexDirection: 'column', lineHeight: 1.1 }, kpiV: { color: 'var(--ui-text)', fontSize: 15, fontVariantNumeric: 'tabular-nums' }, kpiL: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em' },
  btn: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--ui-border)', background: 'transparent', color: 'var(--ui-text)', cursor: 'pointer', fontSize: 12 },
  input: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ui-border)', background: 'transparent', color: 'var(--ui-text)', fontSize: 12, minWidth: 140 },
  h: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--ui-text-secondary)', margin: '12px 0 4px' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 11 }
}
function Kpi({ v, l, tone }) { return jsxs('div', { style: S.kpi, children: [jsx('span', { style: { ...S.kpiV, color: tone || 'var(--ui-text)' }, children: v }), jsx('span', { style: S.kpiL, children: l })] }) }

function MissionBar({ ctx }) {
  const snap = useAtom($snap); const mode = useAtom($mode); const err = useAtom($error); const filter = useAtom($filter); const prefs = useAtom($prefs); const n = useAtom($notice)
  const t = snap ? snap.totals : null
  const ceiling = snap && snap.spend_ceiling_usd; const spend = t ? t.cost_today_usd : 0
  const spendTone = ceiling ? (spend > ceiling ? 'var(--ui-danger)' : (spend > ceiling * 0.8 ? 'var(--ui-warning)' : undefined)) : undefined
  const hb = snap && snap.gateway && snap.gateway.heartbeat_age_s
  const toggleState = (s) => { const next = new Set(filter.states); if (next.has(s) && next.size > 1) next.delete(s); else next.add(s); $filter.set({ ...filter, states: next }) }
  const modeTone = mode === 'live' ? 'var(--ui-success)' : (mode === 'demo' ? 'var(--ui-warning)' : (mode === 'error' ? 'var(--ui-danger)' : 'var(--ui-text-secondary)'))
  return jsxs('div', { style: S.bar, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
      jsx('strong', { style: { color: 'var(--ui-text)', fontSize: 13 }, children: snap ? snap.title : 'Hermes Cockpit' }),
      jsx('span', { title: err || `data: ${mode}`, style: { ...S.chip(false), borderColor: modeTone, color: modeTone }, children: mode })
    ] }),
    t && jsx(Kpi, { v: t.needs_you, l: 'needs you', tone: t.needs_you ? 'var(--ui-danger)' : undefined }),
    t && jsx(Kpi, { v: t.by_state.working + t.by_state.task, l: 'working' }),
    t && jsx(Kpi, { v: t.delegations, l: 'subagents' }),
    t && jsx(Kpi, { v: `${fmtTok(t.tokens_per_min)}/min`, l: 'tokens' }),
    t && jsx(Kpi, { v: fmtUsd(spend) + (ceiling ? ` / ${fmtUsd(ceiling)}` : ''), l: 'today', tone: spendTone }),
    snap && jsx(Kpi, { v: hb == null ? '—' : fmtAge(hb), l: 'gateway hb', tone: hb != null && hb > 300 ? 'var(--ui-warning)' : undefined }),
    snap && (snap.signals || []).map(sg => jsxk(Kpi, { key: sg.id, v: sg.age_s == null ? '—' : fmtAge(sg.age_s), l: sg.label, tone: sg.ok ? undefined : 'var(--ui-danger)' })),
    jsx('span', { style: { flex: 1 } }),
    jsx('div', { style: { display: 'flex', gap: 4 }, children: STATES.map(s => jsxk('span', { key: s, style: S.chip(filter.states.has(s)), onClick: () => toggleState(s), children: STATE_LABEL[s] })) }),
    jsx('input', { 'aria-label': 'Find a unit', placeholder: 'find unit… (/)', value: filter.q, style: S.input, 'data-ck-search': '1', onChange: (e) => $filter.set({ ...filter, q: e.target.value }) }),
    jsx('button', { style: S.btn, title: 'Swimlanes (L)', onClick: () => setPrefs(ctx, { showLanes: !prefs.showLanes }), children: prefs.showLanes ? 'lanes ▾' : 'lanes ▸' }),
    n && Date.now() - n.at < 6000 && jsx('span', { role: 'status', style: { color: n.kind === 'error' ? 'var(--ui-danger)' : (n.kind === 'warn' ? 'var(--ui-warning)' : 'var(--ui-success)') }, children: n.text })
  ] })
}

function GroupRail() {
  const snap = useAtom($snap); const filter = useAtom($filter)
  if (!snap) return null
  const pick = (id) => $filter.set({ ...filter, group: filter.group === id ? null : id })
  return jsxs('div', { style: { display: 'flex', gap: 6, padding: '6px 12px', flexWrap: 'wrap', fontSize: 11 }, children: [
    jsx('span', { style: S.chip(!filter.group), onClick: () => pick(null), children: `all ${snap.totals.units}` }),
    ...(snap.groups || []).map(g => {
      const members = g.profiles.map(p => snap.units[p]).filter(Boolean); const blocked = members.filter(u => u.state === 'blocked').length; const working = members.filter(u => u.state === 'working' || u.state === 'task').length
      return jsxsk('span', { key: g.id, style: S.chip(filter.group === g.id), onClick: () => pick(g.id), children: [g.label, ' ', jsx('span', { style: { opacity: .7 }, children: `${working}↑` }), blocked ? jsx('span', { style: { color: 'var(--ui-danger)' }, children: ` ${blocked}!` }) : null] })
    }),
    snap.pipeline && Object.keys(snap.pipeline).length ? jsx('span', { style: { marginLeft: 'auto', color: 'var(--ui-text-secondary)' }, children: 'board: ' + ['todo', 'ready', 'running', 'blocked', 'review', 'done'].filter(k => snap.pipeline[k] != null).map(k => `${k} ${snap.pipeline[k]}`).join(' · ') }) : null
  ] })
}

function Drawer({ ctx }) {
  const snap = useAtom($snap); const sel = useAtom($selected); const mode = useAtom($mode)
  const [detail, setDetail] = useState(null); const [steer, setSteer] = useState(''); const [task, setTask] = useState('')
  useEffect(() => {
    setDetail(null); if (!sel || mode !== 'live') return
    let alive = true; ctx.rest(`/unit/${encodeURIComponent(sel)}`).then(d => { if (alive) setDetail(d) }).catch(() => {})
    return () => { alive = false }
  }, [sel, mode, snap && snap.rev])
  if (!snap || !sel || !snap.units[sel]) return jsx('div', { style: { padding: 14, color: 'var(--ui-text-secondary)', fontSize: 12 }, children: 'Click a unit for its live steps and controls. Double-click opens a chat with it.' })
  const u = snap.units[sel]; const d = detail || u; const sid = u.latest_session && u.latest_session.id
  const col = `var(--ui-${u.state === 'blocked' ? 'danger' : u.state === 'failed' ? 'warning' : u.state === 'working' ? 'success' : u.state === 'task' ? 'accent' : 'text-secondary'})`
  const row = (k, v) => v == null || v === '' ? null : jsxs('div', { style: { display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' }, children: [jsx('span', { style: { color: 'var(--ui-text-secondary)', minWidth: 86 }, children: k }), jsx('span', { style: { color: 'var(--ui-text)', wordBreak: 'break-word' }, children: v })] })
  const summary = () => `${u.profile} — ${STATE_LABEL[u.state]} for ${fmtAge(snap.ts - u.since)}${u.task ? `; task ${u.task.id} "${u.task.title}"` : ''}${u.blocked.length ? `; blocked: ${u.blocked.map(b => b.title).join(', ')}` : ''}; today ${fmtTok(u.tokens_today)} tok ${fmtUsd(u.cost_today_usd)}`
  return jsxs('div', { style: { padding: '10px 14px', overflow: 'auto', fontSize: 12 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 }, children: [
      jsx('strong', { style: { fontSize: 15, color: 'var(--ui-text)' }, children: u.display_name || u.profile }),
      jsx('span', { style: { color: col }, children: STATE_LABEL[u.state] }), jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: fmtAge(snap.ts - u.since) }),
      jsx('button', { style: { ...S.btn, marginLeft: 'auto' }, onClick: () => $selected.set(null), 'aria-label': 'close', children: '×' })
    ] }),
    u.description && jsx('div', { style: { color: 'var(--ui-text-secondary)', margin: '4px 0' }, children: u.description }),
    jsxs('div', { style: { display: 'flex', gap: 6, margin: '8px 0', flexWrap: 'wrap' }, children: [
      jsx('button', { style: S.btn, onClick: () => actions.openChat(u.profile), children: 'Open chat' }),
      sid && (u.state === 'working' || u.state === 'task') && jsx('button', { style: S.btn, onClick: () => actions.interrupt(u.profile, sid), children: 'Interrupt' }),
      jsx('button', { style: S.btn, onClick: () => actions.copy(summary()), children: 'Copy summary' })
    ] }),
    sid && (u.state === 'working' || u.state === 'task') && jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
      jsx('input', { style: { ...S.input, flex: 1 }, placeholder: 'steer this turn…', value: steer, onChange: e => setSteer(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && steer.trim()) { actions.steer(u.profile, sid, steer.trim()); setSteer('') } } }),
      jsx('button', { style: S.btn, onClick: () => { if (steer.trim()) { actions.steer(u.profile, sid, steer.trim()); setSteer('') } }, children: 'Steer' })
    ] }),
    (u.anomalies || []).length ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'anomalies' }), ...u.anomalies.map((a, i) => jsxsk('div', { key: i, style: { color: 'var(--ui-warning)' }, children: [a.rule, ' — ', jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: a.evidence })] }))] }) : null,
    u.blocked.length ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'needs you' }), ...u.blocked.map(b => jsxsk('div', { key: b.id, style: { padding: '3px 0' }, children: [jsx('span', { style: S.mono, children: b.id }), ' ', b.title, b.block_kind ? jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: ` · ${b.block_kind}` }) : null] }))] }) : null,
    u.task ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'task' }), row('card', `${u.task.id} · ${u.task.title}`), row('since', fmtAge(snap.ts - (u.task.started_at || snap.ts))), row('created by', u.task.created_by), row('board', u.task.board)] }) : null,
    jsx('div', { style: S.h, children: 'unit' }),
    row('model', u.model), row('sessions today', u.sessions_today), row('tokens today', `${fmtTok(u.tokens_today)} · ${fmtUsd(u.cost_today_usd)}`), row('subagents', u.delegations || 0), row('heartbeat', u.heartbeat_age_s == null ? null : fmtAge(u.heartbeat_age_s)),
    u.latest_session ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'latest session' }), row('title', u.latest_session.title), row('source', u.latest_session.source), row('activity', u.latest_session.last_activity_at ? fmtAge(snap.ts - u.latest_session.last_activity_at) + ' ago' : null), row('tool calls', u.latest_session.tool_calls)] }) : null,
    d.recent_tool_calls && d.recent_tool_calls.length ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'live steps' }), ...d.recent_tool_calls.slice(0, 10).map((c, i) => jsxsk('div', { key: i, style: { ...S.mono, color: 'var(--ui-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: [jsx('span', { style: { color: 'var(--ui-text)' }, children: c.tool }), c.target ? ` ${c.target}` : ''] }))] }) : null,
    u.cron && u.cron.jobs ? jsxs('div', { children: [jsx('div', { style: S.h, children: `cron · ${u.cron.jobs} job${u.cron.jobs > 1 ? 's' : ''}${u.cron.errors_recent ? ` · ${u.cron.errors_recent} error` : ''}` }),
      ...(u.cron.list || []).slice(0, 8).map(j => jsxsk('div', { key: j.id, style: { display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }, children: [
        jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: j.schedule || '', children: j.name || j.id }),
        jsx('span', { style: { color: j.last_status === 'error' ? 'var(--ui-danger)' : 'var(--ui-text-secondary)' }, children: j.paused ? 'paused' : (j.last_status || '') }),
        jsx('button', { style: { ...S.btn, padding: '1px 6px' }, onClick: () => actions.cron(u.profile, j.id, j.paused ? 'resume' : 'pause'), children: j.paused ? '▶' : '⏸' })
      ] }))] }) : null,
    snap.mode === 'live' && jsxs('div', { children: [jsx('div', { style: S.h, children: 'hand a card to this unit' }),
      jsxs('div', { style: { display: 'flex', gap: 6 }, children: [
        jsx('input', { style: { ...S.input, flex: 1 }, placeholder: 'task title (needs allow_task_create in cockpit.yaml)', value: task, onChange: e => setTask(e.target.value) }),
        jsx('button', { style: S.btn, onClick: async () => { if (task.trim().length >= 3) { const r = await actions.createTask(ctx, u.profile, task.trim(), ''); if (r) setTask('') } }, children: 'Create' })
      ] })] }),
    d.recent_sessions && d.recent_sessions.length > 1 ? jsxs('div', { children: [jsx('div', { style: S.h, children: 'recent sessions' }), ...d.recent_sessions.slice(0, 6).map(s => jsxsk('div', { key: s.id, style: { display: 'flex', gap: 8, color: 'var(--ui-text-secondary)' }, children: [jsx('span', { style: { color: 'var(--ui-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: s.title || s.id }), jsx('span', { style: S.mono, children: `${fmtTok(s.tokens)} · ${fmtUsd(s.estimated_cost_usd)}` })] }))] }) : null
  ] })
}

function Feed() {
  const feed = useAtom($feed); const sel = useAtom($selected); const [onlyMine, setOnlyMine] = useState(false)
  const rows = feed.filter(e => !onlyMine || !sel || e.profile === sel).slice(-80).reverse()
  const tone = (k) => k === 'state' ? 'var(--ui-accent)' : (k === 'kanban' ? 'var(--ui-text-secondary)' : 'var(--ui-warning)')
  return jsxs('div', { style: { borderTop: '1px solid var(--ui-border)', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }, children: [
    jsxs('div', { style: { ...S.h, margin: 0, padding: '8px 14px 4px', display: 'flex', gap: 8 }, children: ['feed', jsx('span', { style: { flex: 1 } }), sel && jsxs('label', { style: { textTransform: 'none', letterSpacing: 0, cursor: 'pointer' }, children: [jsx('input', { type: 'checkbox', checked: onlyMine, onChange: e => setOnlyMine(e.target.checked) }), ` only ${sel}`] })] }),
    jsx('div', { style: { overflow: 'auto', padding: '0 14px 10px', fontSize: 11 }, children: rows.length ? rows.map(e => jsxsk('div', { key: e.seq, style: { display: 'flex', gap: 8, padding: '2px 0', borderBottom: '1px dashed var(--ui-border)' }, children: [
      jsx('span', { style: { ...S.mono, color: 'var(--ui-text-secondary)' }, children: fmtClock(e.ts) }), jsx('span', { style: { color: tone(e.kind), minWidth: 44 }, children: e.kind }),
      jsx('span', { style: { color: 'var(--ui-text)', cursor: e.profile ? 'pointer' : 'default' }, onClick: () => e.profile && $selected.set(e.profile), children: e.text })
    ] })) : jsx('div', { style: { color: 'var(--ui-text-secondary)' }, children: 'No events yet — state changes and board events land here.' }) })
  ] })
}

function setPrefs(ctx, patch) { const next = { ...$prefs.get(), ...patch }; $prefs.set(next); try { ctx.storage.set('prefs', next) } catch (e) { /* storage unavailable */ } }

function Page({ ctx }) {
  const prefs = useAtom($prefs); const sel = useAtom($selected); const mode = useAtom($mode); const snap = useAtom($snap)
  const [narrow, setNarrow] = useState(false); const root = useRef(null)
  useEffect(() => { const el = root.current; if (!el || typeof ResizeObserver === 'undefined') return; const ro = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < 900)); ro.observe(el); return () => ro.disconnect() }, [])
  return jsxs('div', { ref: root, className: 'hermes-cockpit', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--ui-text)' }, children: [
    jsx(MissionBar, { ctx }),
    jsx(GroupRail, {}),
    mode === 'demo' && jsx('div', { style: { padding: '4px 12px', fontSize: 11, color: 'var(--ui-warning)' }, children: prefs.demo ? 'Demo data (Settings → Plugins → Hermes Cockpit to turn off).' : 'Showing demo data: the sensor is not enabled on this backend and RPC is unreachable. Enable `hermes-cockpit` in plugins.enabled for the live picture.' }),
    mode === 'rpc' && jsx('div', { style: { padding: '4px 12px', fontSize: 11, color: 'var(--ui-text-secondary)' }, children: 'RPC-only picture: sessions per profile, no board/cost. Enable the `hermes-cockpit` python half in plugins.enabled for tasks, cost, cron and anomalies.' }),
    jsxs('div', { style: { display: 'flex', flex: 1, minHeight: 0, flexDirection: narrow ? 'column' : 'row' }, children: [
      jsxs('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }, children: [jsx(Constellation, { ctx }), prefs.showLanes && jsx(Swimlanes, {})] }),
      jsxs('div', { style: { width: narrow ? 'auto' : 340, borderLeft: narrow ? 'none' : '1px solid var(--ui-border)', borderTop: narrow ? '1px solid var(--ui-border)' : 'none', display: 'flex', flexDirection: 'column', minHeight: narrow ? 260 : 0 }, children: [jsx(Drawer, { ctx }), jsx(Feed, {})] })
    ] })
  ] })
}

// ── statusbar chip ──────────────────────────────────────────────────────────────────────
function StatusChip() {
  const snap = useAtom($snap); const mode = useAtom($mode)
  const t = snap && snap.totals
  const text = t ? `◉ ${t.needs_you ? t.needs_you + ' need you · ' : ''}${t.by_state.working + t.by_state.task} working · ${fmtUsd(t.cost_today_usd)}` : `◉ cockpit ${mode}`
  return jsx('button', { onClick: () => host.navigate(PATH), title: 'Open Hermes Cockpit', style: { background: 'transparent', border: 'none', cursor: 'pointer', color: t && t.needs_you ? 'var(--ui-danger)' : 'var(--ui-text-secondary)', fontSize: 11, padding: '0 6px' }, children: text })
}

// ── settings page (Settings → Plugins → Hermes Cockpit) ─────────────────────────────────
function Settings({ ctx }) {
  const p = useAtom($prefs)
  const Row = (label, control, help) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--ui-border)' }, children: [jsxs('div', { style: { flex: 1 }, children: [jsx('div', { style: { color: 'var(--ui-text)', fontSize: 13 }, children: label }), help && jsx('div', { style: { color: 'var(--ui-text-secondary)', fontSize: 11 }, children: help })] }), control] })
  const Toggle = (k) => jsx('input', { type: 'checkbox', checked: !!p[k], onChange: e => setPrefs(ctx, { [k]: e.target.checked }) })
  const Num = (k, min, max, step) => jsx('input', { type: 'number', min, max, step, value: p[k], style: { ...S.input, minWidth: 80 }, onChange: e => setPrefs(ctx, { [k]: Number(e.target.value) }) })
  const Sel = (k, opts) => jsx('select', { value: p[k], style: S.input, onChange: e => setPrefs(ctx, { [k]: e.target.value }), children: opts.map(o => jsxk('option', { key: o, value: o, children: o })) })
  return jsxs('div', { style: { padding: '4px 0', maxWidth: 640 }, children: [
    Row('Poll interval (ms)', Num('pollMs', 1500, 60000, 500), 'How often to ask the sensor. Pushes from the gateway arrive instantly regardless.'),
    Row('Swimlanes', Toggle('showLanes'), 'History strip under the constellation; drag it to replay.'),
    Row('Lane window (minutes)', Num('laneMinutes', 5, 1440, 5)),
    Row('Lanes by', Sel('laneBy', ['group', 'unit'])),
    Row('Show idle units', Toggle('showIdle'), 'Off hides idle/off-duty units from the constellation and lanes.'),
    Row('Density', Sel('density', ['comfortable', 'compact']), 'Compact: smaller nodes, labels only on active units — for 50+ profiles.'),
    Row('Delegation particles', Toggle('particles')),
    Row('Reduced motion', Toggle('reducedMotion'), 'No breathing, orbits or flashes; state still shows by position and colour.'),
    Row('Flash "needs you" in the mission bar', Toggle('focusOnNeedsYou')),
    Row('Demo data', Toggle('demo'), 'Synthetic fleet, for trying the view without a backend.'),
    jsx('div', { style: { color: 'var(--ui-text-secondary)', fontSize: 11, marginTop: 12 }, children: 'Groups, owner seat, thresholds and file signals live on the backend in $HERMES_HOME/cockpit.yaml (hot-reloaded). This page is per-laptop display preference.' })
  ] })
}

// ── plugin ──────────────────────────────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'Hermes Cockpit',
  description: 'Live constellation + swimlanes of every Hermes profile: who works, who needs you, what it costs.',
  defaultEnabled: false,
  register(ctx) {
    try { const saved = ctx.storage.get('prefs', null); if (saved && typeof saved === 'object') $prefs.set({ ...DEFAULT_PREFS, ...saved }) } catch (e) { /* fresh install */ }
    const stopPoll = startPoller(ctx); ctx.onDispose(stopPoll)
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(Page, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Cockpit', codicon: 'radio-tower' } },
      { id: 'status', area: STATUSBAR_AREAS.right, order: 110, render: () => jsx(StatusChip, {}) },
      { id: 'palette.open', area: PALETTE_AREA, data: { id: 'cockpit.open', label: 'Open Cockpit', keywords: ['cockpit', 'fleet', 'mission', 'control', 'agents'], run: () => host.navigate(PATH) } },
      { id: 'palette.needs', area: PALETTE_AREA, data: { id: 'cockpit.needs-you', label: 'Cockpit: jump to the unit that needs me', keywords: ['blocked', 'needs', 'approve'], run: () => { const u = unitsOf($snap.get()).find(x => x.state === 'blocked'); if (u) { $selected.set(u.profile); host.navigate(PATH) } else notice('nothing needs you right now') } } },
      { id: 'palette.demo', area: PALETTE_AREA, data: { id: 'cockpit.demo', label: 'Cockpit: toggle demo data', keywords: ['demo'], run: () => setPrefs(ctx, { demo: !$prefs.get().demo }) } },
      { id: 'kb.open', area: KEYBINDS_AREA, data: { id: 'cockpit.open', label: 'Open Cockpit', category: 'Cockpit', defaults: ['mod+shift+k'], run: () => host.navigate(PATH) } },
      { id: 'kb.lanes', area: KEYBINDS_AREA, data: { id: 'cockpit.lanes', label: 'Toggle swimlanes', category: 'Cockpit', defaults: ['mod+shift+l'], run: () => setPrefs(ctx, { showLanes: !$prefs.get().showLanes }) } },
      { id: 'kb.next', area: KEYBINDS_AREA, data: { id: 'cockpit.next-blocked', label: 'Next unit that needs you', category: 'Cockpit', defaults: ['mod+shift+n'], run: () => { const bl = unitsOf($snap.get()).filter(x => x.state === 'blocked').map(x => x.profile); if (!bl.length) return notice('nothing needs you right now'); const i = bl.indexOf($selected.get()); $selected.set(bl[(i + 1) % bl.length]) } } }
    ])
    if (typeof ctx.registerSettingsPage === 'function') ctx.registerSettingsPage({ id: 'settings', title: 'Hermes Cockpit', icon: 'radio-tower', order: 0, render: () => jsx(Settings, { ctx }) })
    // Keyboard: "/" focuses search when the page is showing; Escape clears selection/replay.
    ctx.addEventListener(window, 'keydown', (e) => {
      const onPage = document.querySelector('.hermes-cockpit'); if (!onPage) return
      const inField = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')
      if (e.key === '/' && !inField) { const s = onPage.querySelector('[data-ck-search]'); if (s) { e.preventDefault(); s.focus() } }
      if (e.key === 'Escape') { if ($replayT.get() != null) $replayT.set(null); else if (!inField) $selected.set(null) }
    })
  }
}

// Exposed for tests only (not part of the plugin contract).
export const __test = { atom, layout, totalsOf, demoSnap, diffToFeed, fmtAge, fmtTok, $snap, $feed, $history, $mode, $prefs, $selected, $filter, $replayT, STATES }
