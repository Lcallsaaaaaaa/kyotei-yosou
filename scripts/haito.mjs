// 券種ごとの配当金の分布。
//   node --max-old-space-size=6144 scripts/haito.mjs
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const KINDS = [['tansho', '単勝'], ['fukusho', '複勝'], ['nirenpuku', '2連複'],
  ['nirentan', '2連単'], ['sanrenpuku', '3連複'], ['sanrentan', '3連単']]
const out = {}
for (const [k, nm] of KINDS) {
  const a = db.prepare(`SELECT amount FROM payouts WHERE bet_type=? AND amount IS NOT NULL ORDER BY amount`).all(k).map((r) => r.amount)
  if (!a.length) continue
  const q = (x) => a[Math.min(a.length - 1, Math.floor(a.length * x))]
  const mean = a.reduce((x, y) => x + y, 0) / a.length
  out[k] = { nm, n: a.length, mean, min: a[0], q10: q(0.1), q25: q(0.25), med: q(0.5), q75: q(0.75), q90: q(0.9), q95: q(0.95), q99: q(0.99), max: a[a.length - 1], a }
}
console.log('券種ごとの配当（100円あたり・全期間）\n')
console.log('券種    本数     平均     最低   下位10%  下位25%   中央   上位25%  上位10%  上位5%   上位1%     最高')
for (const [k, nm] of KINDS) {
  const o = out[k]; if (!o) continue
  const f = (v) => String(Math.round(v)).padStart(7)
  console.log(`${nm.padEnd(6)} ${String(o.n).padStart(7)} ${f(o.mean)} ${f(o.min)} ${f(o.q10)} ${f(o.q25)} ${f(o.med)} ${f(o.q75)} ${f(o.q90)} ${f(o.q95)} ${f(o.q99)} ${f(o.max)}`)
}
console.log('\n配当帯ごとの割合（%）')
const B = [110, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 1e9]
const LB = ['〜110', '〜150', '〜200', '〜300', '〜500', '〜1000', '〜2000', '〜5000', '〜1万', '1万超']
console.log('券種    ' + LB.map((s) => s.padStart(7)).join(''))
for (const [k, nm] of KINDS) {
  const o = out[k]; if (!o) continue
  const c = new Array(B.length).fill(0)
  for (const v of o.a) { const i = B.findIndex((b) => v <= b); if (i >= 0) c[i]++ }
  console.log(nm.padEnd(6) + '  ' + c.map((x) => (x / o.n * 100).toFixed(1).padStart(7)).join(''))
}
console.log('\n※平均は上位のごく一部に引っ張られる。中央値との差が大きいほど「たまに大きいのが出る」券種。')
for (const [k, nm] of KINDS) {
  const o = out[k]; if (!o) continue
  console.log(`  ${nm.padEnd(6)} 平均${Math.round(o.mean)}円 / 中央${Math.round(o.med)}円 = ${(o.mean / o.med).toFixed(2)}倍`)
}
db.close()
