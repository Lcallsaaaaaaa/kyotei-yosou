// 3連単・3連複を「モデルの確率 × 推定オッズ」で選ぶ。モデルは変えない。
//   node --max-old-space-size=6144 scripts/ev3.mjs
//
// ★いままで：モデルの確率が高い順に上位N点を買う → 回収80〜83%
// ★これから：買い目ごとに「モデルの確率 × 推定オッズ」を出し、一定以上だけ買う
//   推定オッズは単勝オッズからHarville方式で作り、中央のずれ(1.335倍)を補正する。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const BIAS = 1.335   // Harvilleの推定オッズが実配当より中央で何倍大きいか

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
    WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
const MO = new Map()
for (const r of db.prepare(`SELECT DISTINCT race_id, month FROM wi1`).iterate()) MO.set(r.race_id, r.month)

const mktQ = (o) => {
  const r = [1, 2, 3, 4, 5, 6].map((l) => (o[l] > 0 ? 1 / o[l] : 0))
  const s = r.reduce((a, b) => a + b, 0)
  return r.map((v) => v / s)
}
const harv = (q, a, b, c) => {
  const d1 = 1 - q[a], d2 = 1 - q[a] - q[b]
  if (d1 <= 1e-6 || d2 <= 1e-6) return 0
  return q[a] * (q[b] / d1) * (q[c] / d2)
}
// レースごとに買い目を作る
const races = []
let cur = null, rows = []
const flush = () => {
  if (!cur) { rows = []; return }
  const o = OD.get(cur)
  if (o && [1, 2, 3, 4, 5, 6].every((l) => o[l] > 0) && rows.length === 120) {
    const q = mktQ(o)
    const list = []
    for (const r of rows) {
      const [a, b, c] = r.combo.split('-').map(Number)
      const mp = harv(q, a - 1, b - 1, c - 1)
      if (!(mp > 0)) continue
      const est = (0.75 / mp) / BIAS      // 推定オッズ（補正済み）
      list.push({ combo: r.combo, p: r.p, est, ev: r.p * est })
    }
    if (list.length) races.push({ rid: cur, mo: MO.get(cur), list })
  }
  rows = []
}
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()) {
  if (r.race_id !== cur) { flush(); cur = r.race_id }
  rows.push(r)
}
flush()
console.log(`${races.length.toLocaleString()}レース（単勝オッズと予想が両方そろう）\n`)

const fold = (c) => c.split('-').sort().join('-')
const run = (kind, sel, maxPts) => {
  let n = 0, bets = 0, hit = 0, ret = 0
  for (const r of races) {
    const pick = sel(r).slice(0, maxPts)
    if (!pick.length) continue
    n++
    const seen = new Set()
    for (const x of pick) {
      const c = kind === 'sanrenpuku' ? fold(x.combo) : x.combo
      if (kind === 'sanrenpuku') { if (seen.has(c)) continue; seen.add(c) }
      bets++
      const a = PAY.get(r.rid + '|' + kind + '|' + c)
      if (a != null) { hit++; ret += a }
    }
  }
  if (!bets) return null
  return { n, bets, hr: hit / Math.max(n, 1) * 100, roi: ret / (bets * 100) * 100,
    avg: hit ? ret / hit : 0, perRace: (ret - bets * 100) / Math.max(n, 1), bpr: bets / Math.max(n, 1) }
}
console.log('■ 3連単')
console.log('  選び方                        買うレース  1レース点数  的中率  平均払戻   回収率  1レース損益')
for (const pts of [1, 3, 6]) {
  const x = run('sanrentan', (r) => r.list.slice().sort((a, b) => b.p - a.p), pts)
  console.log(`  確率の高い順 ${pts}点               ${String(x.n).padStart(7)} ${x.bpr.toFixed(1).padStart(11)} ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(7)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.perRace.toFixed(0).padStart(9)}円`)
}
for (const th of [1.0, 1.2, 1.5, 2.0, 3.0]) {
  for (const pts of [6, 12]) {
    const x = run('sanrentan', (r) => r.list.filter((y) => y.ev >= th).sort((a, b) => b.ev - a.ev), pts)
    if (!x || x.n < 200) continue
    console.log(`  期待値${th.toFixed(1)}以上・最大${String(pts).padStart(2)}点        ${String(x.n).padStart(7)} ${x.bpr.toFixed(1).padStart(11)} ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(7)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.perRace.toFixed(0).padStart(9)}円`)
  }
}
console.log('\n■ 3連複')
for (const pts of [1, 3, 6]) {
  const x = run('sanrenpuku', (r) => {
    const m = new Map()
    for (const y of r.list) { const k = fold(y.combo); const c = m.get(k); if (c) { c.p += y.p; c.ev += y.ev } else m.set(k, { combo: y.combo, p: y.p, ev: y.ev }) }
    return [...m.values()].sort((a, b) => b.p - a.p)
  }, pts)
  console.log(`  確率の高い順 ${pts}点               ${String(x.n).padStart(7)} ${x.bpr.toFixed(1).padStart(11)} ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(7)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.perRace.toFixed(0).padStart(9)}円`)
}
for (const th of [1.0, 1.2, 1.5, 2.0]) {
  for (const pts of [4, 8]) {
    const x = run('sanrenpuku', (r) => {
      const m = new Map()
      for (const y of r.list) { const k = fold(y.combo); const c = m.get(k); if (c) { c.p += y.p; c.ev += y.ev } else m.set(k, { combo: y.combo, p: y.p, ev: y.ev }) }
      return [...m.values()].filter((y) => y.ev >= th).sort((a, b) => b.ev - a.ev)
    }, pts)
    if (!x || x.n < 200) continue
    console.log(`  期待値${th.toFixed(1)}以上・最大${String(pts).padStart(2)}点        ${String(x.n).padStart(7)} ${x.bpr.toFixed(1).padStart(11)} ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(7)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.perRace.toFixed(0).padStart(9)}円`)
  }
}
db.close()
