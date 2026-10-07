// Browser-side mock of `@hermes/plugin-sdk` for dev/harness.html. Only what plugin.js imports.
// `host.request*` have no gateway here: they log and resolve, so the UI's actions are visible
// without side effects. Set `__mock.gateway = async (profile, method, params) => …` to wire one.
import React from 'react'

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'nav'
export const STATUSBAR_AREAS = { left: 'statusbar.left', center: 'statusbar.center', right: 'statusbar.right' }
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const WORKSPACE_PAGE_HEADER_AREA = 'workspace.header'

export function useValue(store) {
  const [v, set] = React.useState(store.get())
  React.useEffect(() => store.listen(set), [store])
  return v
}

export const __mock = { onLog: (m) => console.log(m), gateway: null }
const say = (m) => { try { __mock.onLog(m) } catch (e) { /* ignore */ } }

export const host = {
  navigate: (p) => say(`navigate ${p}`),
  newChat: (p) => say(`newChat(${p || 'default'})`),
  openSession: async (id) => say(`openSession ${id}`),
  onEvent: (name, fn) => { __mock.lastEvent = { name, fn }; return () => {} },
  request: async (m, params) => { say(`rpc ${m}`); if (__mock.gateway) return __mock.gateway(null, m, params); throw new Error('no gateway in harness') },
  requestProfile: async (profile, m, params) => { say(`rpc ${profile} ${m} ${JSON.stringify(params || {}).slice(0, 60)}`); if (__mock.gateway) return __mock.gateway(profile, m, params); return { ok: true, mocked: true } }
}
export default { host, useValue }
