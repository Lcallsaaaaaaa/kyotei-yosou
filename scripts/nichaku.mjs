// 2着に伸びしろがあるのか。市場と直接比べる。
//   node --max-old-space-size=8192 scripts/nichaku.mjs
//
// ★やり方
//   3連単オッズから市場の3連単確率を作り、1着で条件づけて「2着の見立て」を取り出す。
//   同じことをモデルでもやり、**本当の1着を知っている前提**で2着の当たり具合を比べる。
//   1着の精度を切り離せるので、2着そのものの実力が分かる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const MP = new Map()   // モデルの3連単確率
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = MP.get(r.race_id); if (!a) { a = new Map(); MP.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120) {
      const w = WIN.get(cur), mp = MP.get(cur)
      if (w && w[1] && w[2] && w[3] && mp) {
        // 市場の確率＝1/オッズ を正規化
        let s = 0
        const q = new Map()
        for (const x of list) { const v = 1 / x.odds; q.set(x.combo, v); s += v }
        for (const [k, v] of q) q.set(k, v / s)
        races.push({ rid: cur, w, q, mp })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, odds FROM odds3t WHERE odds IS NOT NULL ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
console.log(`${races.length.toLocaleString()}レース（3連単オッズとモデル予想がそろう）\n`)
// 1着を知っている前提で、2着を当てられるか
const cond2 = (m, first) => {
  const out = new Map()
  for (const [c, p] of m) { const q = c.split('-'); if (Number(q[0]) !== first) continue; out.set(q[1], (out.get(q[1]) ?? 0) + p) }
  const t = [...out.values()].reduce((a, b) => a + b, 0) || 1
  return [...out].map(([k, v]) => [k, v / t]).sort((a, b) => b[1] - a[1])
}
const cond3 = (m, first, second) => {
  const out = new Map()
  for (const [c, p] of m) { const q = c.split('-'); if (Number(q[0]) !== first || Number(q[1]) !== second) continue; out.set(q[2], (out.get(q[2]) ?? 0) + p) }
  const t = [...out.values()].reduce((a, b) => a + b, 0) || 1
  return [...out].map(([k, v]) => [k, v / t]).sort((a, b) => b[1] - a[1])
}
const run = (get, nm) => {
  let n = 0, h1 = 0, h2 = 0, h3 = 0, ll = 0
  let g1 = 0, g2 = 0
  for (const r of races) {
    const s = cond2(get(r), r.w[1])
    if (!s.length) continue
    n++
    const t = String(r.w[2])
    if (s[0][0] === t) h1++
    if (s.slice(0, 2).some(([k]) => k === t)) h2++
    if (s.slice(0, 3).some(([k]) => k === t)) h3++
    const p = s.find(([k]) => k === t)?.[1] ?? 1e-6
    ll -= Math.log(Math.max(p, 1e-9))
    // 3着も（1着2着を知っている前提）
    const u = cond3(get(r), r.w[1], r.w[2])
    if (u.length) { g2++; if (u[0][0] === String(r.w[3])) g1++ }
  }
  console.log(`  ${nm.padEnd(10)} 2着1点 ${(h1 / n * 100).toFixed(2)}%　2着2点 ${(h2 / n * 100).toFixed(2)}%　2着3点 ${(h3 / n * 100).toFixed(2)}%　対数損失 ${(ll / n).toFixed(4)}　3着1点 ${(g1 / g2 * 100).toFixed(2)}%`)
  return { h1: h1 / n, ll: ll / n }
}
console.log('★ 本当の1着を知っている前提で、2着を当てる')
const A = run((r) => r.mp, 'モデル')
const B = run((r) => r.q, '市場')
console.log('')
// 混ぜたら
console.log('★ モデルと市場を混ぜたら（対数で重みβ）')
for (const b of [0.2, 0.4, 0.6, 0.8, 1.0, 1.5]) {
  const mix = (r) => {
    const out = new Map()
    for (const [c, p] of r.mp) { const q = r.q.get(c) ?? 1e-9; out.set(c, Math.exp(Math.log(Math.max(p, 1e-9)) + b * Math.log(Math.max(q, 1e-9)))) }
    return out
  }
  run(mix, `β=${b.toFixed(1)}`)
}
console.log('\n★ 参考：1着そのものの比較')
{
  const first = (m) => { const o = new Map()
    for (const [c, p] of m) { const l = c.slice(0, c.indexOf('-')); o.set(l, (o.get(l) ?? 0) + p) }
    return [...o].sort((a, b) => b[1] - a[1]) }
  let n = 0, hm = 0, hq = 0
  for (const r of races) { n++
    if (first(r.mp)[0][0] === String(r.w[1])) hm++
    if (first(r.q)[0][0] === String(r.w[1])) hq++ }
  console.log(`  モデル ${(hm / n * 100).toFixed(2)}%　市場 ${(hq / n * 100).toFixed(2)}%`)
}
db.close()
