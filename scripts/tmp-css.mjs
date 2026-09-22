import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/status.mjs'
let s = readFileSync(p, 'utf8')
const bad = "margin-bottom:12px}',\n'.note{"
if (!s.includes(bad)) { console.log('該当なし'); process.exit(0) }
s = s.replace(bad, "margin-bottom:12px}\n.note{")
writeFileSync(p, s)
console.log('直した')
