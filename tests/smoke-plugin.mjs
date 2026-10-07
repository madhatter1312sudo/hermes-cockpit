// Smoke test for desktop/plugin.js: load it uncompiled in jsdom with a mock SDK, register,
// mount the route, drive the three data doors (live → rpc → demo), click a node, scrub lanes.
// Run: node tests/smoke-plugin.mjs   (needs react, react-dom, jsdom resolvable; see tests/README)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const depsDir = process.env.SMOKE_DEPS || path.resolve(root, 'node_modules')
const require = createRequire(path.join(depsDir, 'package.json'))
const { JSDOM } = require('jsdom')

// ── DOM first, then React (React reads `window` at import) ──────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="root" style="width:1200px;height:800px"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const { window } = dom
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'KeyboardEvent', 'Event']) {
  if (!(k in globalThis) || k === 'navigator') { try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }) } catch (e) { /* read-only in some node versions */ } }
}
globalThis.performance = globalThis.performance || window.performance
// canvas: jsdom has no 2d context; give it a recording stub so draw code runs.
const calls = { arc: 0, fillText: 0 }
window.HTMLCanvasElement.prototype.getContext = function () {
  const noop = () => {}
  return new Proxy({}, { get: (_, k) => { if (k === 'measureText') return (t) => ({ width: String(t).length * 6 }); if (k === 'arc') return () => { calls.arc++ }; if (k === 'fillText') return () => { calls.fillText++ }; return noop }, set: () => true })
}
window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0 } }
window.ResizeObserver = class { observe() {} disconnect() {} }
if (!window.navigator.clipboard) Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } })

const React = require('react')
const ReactDOM = require('react-dom/client')
const jsxRuntime = require('react/jsx-runtime')
const { act } = require('react')

// ── mock SDK ────────────────────────────────────────────────────────────────────────────
const log = { requests: [], navigate: [], newChat: [], events: {} }
let restMode = 'live' // live | fail
const LIVE = JSON.parse(readFileSync(path.join(here, 'fixtures', 'fleet-live.json'), 'utf8'))
const sdk = {
  ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { left: 'sb.l', right: 'sb.r' }, PALETTE_AREA: 'palette', KEYBINDS_AREA: 'keybinds',
  useValue: (store) => { throw new Error('plugin must not use the SDK useValue on non-nanostore atoms') },
  host: {
    navigate: (p) => log.navigate.push(p), newChat: (p) => log.newChat.push(p),
    onEvent: (name, fn) => { log.events[name] = fn; return () => { delete log.events[name] } },
    request: async (m, p) => { log.requests.push([m, p]); if (m === 'profiles.list') return { profiles: [{ name: 'default' }, { name: 'alpha', model: 'm1' }, { name: 'beta' }] }; throw new Error('unknown ' + m) },
    requestProfile: async (prof, m, p) => { log.requests.push([prof, m, p]); if (m === 'session.active_list') return { sessions: prof === 'alpha' ? [{ id: 's1', status: 'running', title: 'Alpha work', last_active: Date.now() / 1000 }] : [] }; return { ok: true } }
  }
}
// Rewrite the three bare specifiers to local files (the real app resolves them natively).
const tmp = path.join(root, '.smoke'); mkdirSync(tmp, { recursive: true })
writeFileSync(path.join(tmp, 'sdk.mjs'), 'export default null;\n' + Object.keys(sdk).map(k => `export const ${k} = globalThis.__sdk.${k};`).join('\n'))
writeFileSync(path.join(tmp, 'react.mjs'), 'const R = globalThis.__react; export default R; export const { useState, useEffect, useRef, useCallback, useMemo } = R;')
writeFileSync(path.join(tmp, 'jsx.mjs'), 'export const jsx = globalThis.__jsx.jsx; export const jsxs = globalThis.__jsx.jsxs; export const Fragment = globalThis.__jsx.Fragment;')
globalThis.__sdk = sdk; globalThis.__react = React; globalThis.__jsx = jsxRuntime
const src = readFileSync(path.join(root, 'desktop', 'plugin.js'), 'utf8')
  .replace("from 'react/jsx-runtime'", `from '${pathToFileURL(path.join(tmp, 'jsx.mjs')).href}'`)
  .replace("from 'react'", `from '${pathToFileURL(path.join(tmp, 'react.mjs')).href}'`)
  .replace("from '@hermes/plugin-sdk'", `from '${pathToFileURL(path.join(tmp, 'sdk.mjs')).href}'`)
if (/import .* from '(?!file:)/.test(src)) throw new Error('plugin.js imports a specifier other than the three allowed ones')
writeFileSync(path.join(tmp, 'plugin.mjs'), src)
const mod = await import(pathToFileURL(path.join(tmp, 'plugin.mjs')).href)
const plugin = mod.default; const T = mod.__test

// ── ctx mock ────────────────────────────────────────────────────────────────────────────
const timers = new Set(); const contribs = []; const disposers = []; const storage = new Map(); let settingsPage = null
const ctx = {
  storage: { get: (k, d) => storage.has(k) ? storage.get(k) : d, set: (k, v) => storage.set(k, v), remove: (k) => storage.delete(k) },
  setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn() }, Math.min(ms, 50)); timers.add(id); return () => { clearTimeout(id); timers.delete(id) } },
  setInterval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id) },
  addEventListener: (t, type, fn, o) => { t.addEventListener(type, fn, o); return () => t.removeEventListener(type, fn, o) },
  onDispose: (fn) => disposers.push(fn), register: (c) => { contribs.push(c); return () => {} }, registerMany: (cs) => { cs.forEach(c => contribs.push(c)); return () => {} },
  registerSettingsPage: (p) => { settingsPage = p; return () => {} },
  rest: async (p, o) => { log.requests.push(['rest', p, o && o.method]); if (restMode === 'fail') { const e = new Error('404'); throw e } if (p === '/fleet') return LIVE; if (p.startsWith('/feed')) return { items: /since=0\b/.test(p) ? [{ seq: 1, ts: LIVE.ts, kind: 'state', profile: 'chief', text: 'chief: idle → working' }] : [] }; if (p.startsWith('/history')) return { points: [{ ts: LIVE.ts - 600, states: { chief: 'working', sourcer: 'task' }, tpm: { chief: 1200 } }, { ts: LIVE.ts, states: { chief: 'working', sourcer: 'blocked' }, tpm: {} }] }; if (p.startsWith('/unit/')) return { ...LIVE.units.chief, recent_tool_calls: [{ tool: 'read_file', target: '/x' }], recent_sessions: [{ id: 's1', title: 'A', tokens: 10, estimated_cost_usd: 0.1 }, { id: 's2', title: 'B', tokens: 5, estimated_cost_usd: 0.05 }] }; if (p === '/task') return { ok: true, task_id: 'T9' }; throw new Error('404') },
  socket: () => () => {}
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const setVal = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
function assert(c, m) { if (!c) { console.error('FAIL', m); process.exitCode = 1; throw new Error(m) } console.log('ok  ', m) }

// ── 1. pure helpers ─────────────────────────────────────────────────────────────────────
assert(plugin.id === 'hermes-cockpit' && plugin.defaultEnabled === false, 'plugin id + defaultEnabled:false')
const L = T.layout(LIVE, 1000, 600, true)
assert(L.pos.default && Math.abs(L.pos.default.x - 500) < 1 && L.arcs.length === LIVE.groups.filter(g => g.profiles.some(x => x !== LIVE.owner)).length, 'layout: owner centred, one arc per group with non-owner members')
assert(L.pos.editor.r < L.pos.chief.r && L.pos.editor.r < L.pos.default.r + L.inner + 1, 'layout: blocked unit pulled to the inner ring')
const d1 = T.demoSnap(null); const d2 = T.demoSnap(d1)
assert(Object.keys(d2.units).length === 16 && d2.rev === 2 && d2.totals.units === 16, 'demo fleet evolves deterministically')
assert(T.fmtTok(1234567) === '1.2M' && T.fmtAge(3700) === '1.0h', 'formatters')

// ── 2. register + mount ─────────────────────────────────────────────────────────────────
plugin.register(ctx)
assert(contribs.find(c => c.area === 'routes' && c.data.path === '/cockpit'), 'route contributed')
assert(contribs.filter(c => c.area === 'palette').length === 3 && contribs.filter(c => c.area === 'keybinds').length === 3 && contribs.find(c => c.area === 'sb.r'), 'palette ×3, keybinds ×3, statusbar chip')
assert(settingsPage && settingsPage.title === 'Hermes Cockpit', 'settings page registered')
await sleep(120)
assert(T.$mode.get() === 'live' && T.$snap.get().units.chief, 'live door: /fleet applied')
assert(T.$feed.get().length === 1 && T.$history.get().length >= 2, 'live door: feed + history loaded')

const rootEl = window.document.getElementById('root'); const rootR = ReactDOM.createRoot(rootEl)
const route = contribs.find(c => c.area === 'routes')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
await act(async () => { rootR.render(route.render()) }); await act(async () => { await sleep(60) })
const text = rootEl.textContent
assert(/needs you/.test(text) && /working/.test(text) && /tokens/.test(text), 'mission bar renders KPIs')
assert(rootEl.querySelectorAll('canvas').length === 2, 'constellation + swimlanes canvases mounted')
assert(/Leadership/.test(text) && /board:/.test(text), 'group rail + pipeline strip')
await act(async () => { await sleep(80) })
assert(calls.arc > 20 && calls.fillText > 5, `draw loop ran (arc=${calls.arc}, text=${calls.fillText})`)

// click a node: force the smoothed position by selecting programmatically then verifying the drawer
await act(async () => { T.$selected.set('chief') }); await act(async () => { await sleep(60) })
assert(/live steps/.test(rootEl.textContent) && /read_file/.test(rootEl.textContent) && /recent sessions/.test(rootEl.textContent), 'drawer shows detail from /unit/<p>')
const steerInput = Array.from(rootEl.querySelectorAll('input')).find(i => /steer/.test(i.placeholder))
assert(steerInput, 'steer box visible for a working unit')
await act(async () => { setVal(steerInput, 'focus on Eindhoven') })
const steerBtn = Array.from(rootEl.querySelectorAll('button')).find(b => b.textContent === 'Steer')
await act(async () => { steerBtn.click(); await sleep(10) })
assert(log.requests.some(r => r[0] === 'chief' && r[1] === 'session.steer' && r[2].text === 'focus on Eindhoven'), 'steer goes through session.steer on the unit profile')
const openBtn = Array.from(rootEl.querySelectorAll('button')).find(b => b.textContent === 'Open chat'); await act(async () => { openBtn.click() })
assert(log.newChat[0] === 'chief', 'Open chat → host.newChat(profile)')
// task creation POSTs /task
const taskInput = Array.from(rootEl.querySelectorAll('input')).find(i => /task title/.test(i.placeholder))
await act(async () => { setVal(taskInput, 'Source two embedded leads') })
await act(async () => { Array.from(rootEl.querySelectorAll('button')).find(b => b.textContent === 'Create').click(); await sleep(10) })
assert(log.requests.some(r => r[0] === 'rest' && r[1] === '/task' && r[2] === 'POST'), 'Create → POST /task')
// replay scrub
const lanes = rootEl.querySelectorAll('canvas')[1]
await act(async () => { lanes.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 400, clientY: 20 })) })
assert(T.$replayT.get() != null && T.$replayT.get() < LIVE.ts, 'scrubbing lanes sets a replay time in the past')
await act(async () => { window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })) })
assert(T.$replayT.get() == null, 'Escape leaves replay')
// push event triggers an immediate refetch
const before = log.requests.filter(r => r[0] === 'rest' && r[1] === '/fleet').length
log.events['plugin.hermes-cockpit.fleet.changed']({ needs_you: 2 }); await sleep(40)
assert(log.requests.filter(r => r[0] === 'rest' && r[1] === '/fleet').length > before, 'fleet.changed push → immediate /fleet')
// palette: jump to the unit that needs me
contribs.find(c => c.area === 'palette' && c.data.id === 'cockpit.needs-you').data.run()
assert(T.$selected.get() === 'editor' && log.navigate.includes('/cockpit'), 'palette "needs me" selects the blocked unit and navigates')

// ── 3. rpc door ─────────────────────────────────────────────────────────────────────────
restMode = 'fail'; await sleep(200)
assert(T.$mode.get() === 'rpc', 'sensor gone → rpc door')
const rs = T.$snap.get(); assert(rs.units.alpha && rs.units.alpha.state === 'working' && rs.units.beta.state === 'idle' && rs.mode === 'rpc', 'rpc picture: profiles.list + session.active_list per profile')
await act(async () => { await sleep(30) })
assert(/RPC-only picture/.test(rootEl.textContent), 'rpc banner shown')

// ── 4. demo door ────────────────────────────────────────────────────────────────────────
sdk.host.request = async () => { throw new Error('no backend') }
await sleep(400)
assert(T.$mode.get() === 'demo' && T.$snap.get().mode === 'demo', 'everything unreachable → demo door after 3 failures')
await act(async () => { await sleep(30) })
assert(/Showing demo data/.test(rootEl.textContent), 'demo banner shown')

// ── 5. settings + dispose ───────────────────────────────────────────────────────────────
await act(async () => { rootR.render(settingsPage.render()) }); await act(async () => { await sleep(10) })
assert(/Poll interval/.test(rootEl.textContent) && /Reduced motion/.test(rootEl.textContent), 'settings page renders')
const demoToggle = Array.from(rootEl.querySelectorAll('input[type=checkbox]')).find(i => i.parentElement.textContent.startsWith('Demo data'))
await act(async () => { demoToggle.click() })
assert(storage.get('prefs') && typeof storage.get('prefs').demo === 'boolean', 'prefs persist through ctx.storage')
await act(async () => { rootR.unmount() })
disposers.forEach(f => f()); await sleep(80)
assert(timers.size === 0, 'dispose stops the poller (no live timers)')
console.log('\nALL OK')
process.exit(0)
