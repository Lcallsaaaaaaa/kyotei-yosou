// Benter方式：モデルの確率と市場の確率を対数で混ぜたとき、1着的中がどこまで上がるか。
//
//   node --max-old-space-size=5120 scripts/blend2.mjs --t wi1
//
// ★出典の考え方（Benter 1994, Hong Kong）
//   単独モデルの確率は「市場と独立な推定」ではなく、市場に寄せると当たりが増える。
//   彼の数字では 市場R²0.1218 / 単独モデル0.1245 / 混ぜたもの0.1396。
//   混ぜたときの伸びが、単独モデルを磨くより大きかった。
//
// ⚠ ここでは確定オッズを使う。買う時点では分からないので**上限の測定**であって、
//   そのまま運用はできない。締切前オッズで同じことができるかは別に測る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wi1')

const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let m = O.get(r.race_id); if (!m) { m = {}; O.set(r.race_id, m) }
  m[r.lane] = r.tansho
}
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = O.get(rid); if (!o) continue
  const od = bs.map((b) => o[b.lane])
  if (od.some((v) => !(v > 0))) continue
  const raw = od.map((v) => 1 / v)
  const s = raw.reduce((a, b) => a + b, 0)
  rs.push({ p: bs.map((b) => b.p), q: raw.map((v) => v / s), y: bs.map((b) => b.y), lane: bs.map((b) => b.lane) })
}
const N = rs.length
console.log(`${N.toLocaleString()}レース（モデルと確定オッズが両方そろう）\n`)
const hit = (f) => {
  let h = 0
  for (const r of rs) {
    let bi = -1, bv = -Infinity
    for (let i = 0; i < 6; i++) { const v = f(r, i); if (v > bv) { bv = v; bi = i } }
    if (r.y[bi] === 1) h++
  }
  return h / N * 100
}
const L = (x) => Math.log(Math.max(x, 1e-9))
console.log(`モデル単独        ${hit((r, i) => L(r.p[i])).toFixed(2)}%`)
console.log(`市場単独          ${hit((r, i) => L(r.q[i])).toFixed(2)}%`)
console.log('')
console.log('混ぜ方（モデルの重みα・市場の重みβ）')
console.log('   α     β    1着的中')
let best = null
for (const a of [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0]) {
  for (const b of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5]) {
    const v = hit((r, i) => a * L(r.p[i]) + b * L(r.q[i]))
    if (!best || v > best.v) best = { a, b, v }
  }
}
for (const a of [1.0]) for (const b of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0]) {
  console.log(`  ${a.toFixed(1)}  ${b.toFixed(1)}  ${hit((r, i) => a * L(r.p[i]) + b * L(r.q[i])).toFixed(2)}%`)
}
console.log(`\n最良 α=${best.a} β=${best.b} → ${best.v.toFixed(2)}%`)
// 上位X%に絞ったとき
const sc = rs.map((r) => {
  const s = [...Array(6)].map((_, i) => best.a * L(r.p[i]) + best.b * L(r.q[i]))
  const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
  const t = ex.reduce((x, y) => x + y, 0)
  const pr = ex.map((v) => v / t)
  let bi = 0; for (let i = 1; i < 6; i++) if (pr[i] > pr[bi]) bi = i
  return { p: pr[bi], hit: r.y[bi] === 1 ? 1 : 0 }
})
sc.sort((x, y) => y.p - x.p)
console.log('\n混ぜたモデルで上位X%だけ買う')
console.log('  上位    レース数   1日     的中率')
for (const q of [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0]) {
  const k = Math.round(N * q), s = sc.slice(0, k)
  console.log(`  ${(q * 100).toFixed(0).padStart(4)}%  ${String(k).padStart(8)} ${(k / 303).toFixed(1).padStart(6)}本 ${(s.reduce((a, x) => a + x.hit, 0) / k * 100).toFixed(2).padStart(9)}%`)
}
db.close()
