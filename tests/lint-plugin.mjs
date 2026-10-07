// Disk-plugin rules for desktop/plugin.js (the desktop app enforces the first two at load time;
// catching them here is cheaper than a broken plugin row).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'plugin.js')
const src = readFileSync(file, 'utf8')
const lines = src.split('\n')
const problems = []

// 1. only three import specifiers resolve
for (const m of src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)) {
  if (!['react', 'react/jsx-runtime', '@hermes/plugin-sdk'].includes(m[1])) problems.push(`import of '${m[1]}' will not resolve in the app`)
}
// 2. no JSX (file is loaded uncompiled)
lines.forEach((l, i) => { if (/^\s*(return\s+)?<[A-Z][A-Za-z]*[\s>]/.test(l) || /=\s*<[a-zA-Z]+[\s>][^']*$/.test(l)) problems.push(`${i + 1}: looks like JSX`) })
// 3. no hard-coded colours outside the documented fallback table
lines.forEach((l, i) => { if (/#[0-9a-fA-F]{3,8}\b/.test(l) && !/VAR_FALLBACK|--ui-text-on-accent/.test(l) && !/^\s*\/\//.test(l)) problems.push(`${i + 1}: hard-coded colour: ${l.trim().slice(0, 80)}`) })
// 4. no bare window timers / listeners (must go through ctx)
lines.forEach((l, i) => { if (/\bwindow\.(setTimeout|setInterval|addEventListener)\(/.test(l) || /(^|[^.\w])setInterval\(/.test(l) && !/ctx\.setInterval/.test(l)) problems.push(`${i + 1}: untracked timer/listener (use ctx.*)`) })
// 5. export shape
if (!/export default \{/.test(src) || !/id: ID/.test(src) || !/register\(ctx\)/.test(src)) problems.push('default export must be a HermesPlugin with id + register(ctx)')

if (problems.length) { console.error('plugin lint FAILED\n  ' + problems.join('\n  ')); process.exit(1) }
console.log(`plugin lint ok (${lines.length} lines)`)
