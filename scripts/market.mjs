// 市場（オッズ）と自分のモデルを正面から比べる。
//
//   node scripts/market.mjs
//
// ★ここで決まる
//   回収率が全戦略で100%未満だった。原因は2つのどちらか：
//     (A) モデルが市場より劣っている → 何を買っても負ける。作り直すしかない
//     (B) モデルは市場が知らないことを知っているが、買い方が悪い → 買い方を直せば勝てる
//   どちらなのかを、憶測ではなく数字で確定させる。
//
// ★市場の確率の出し方
//   3連単オッズの逆数が、控除前の市場の見立て。合計すると約1.33になる（控除率25%のぶん）。
//   合計1に直せば、市場が考える確率になる。
//   1着の確率は、その艇が1着の20通りを合計すれば出る。
//
// ★決定的な検定
//   「実際に1着だったか」を、市場の確率と自分の確率の両方で説明させる。
//   自分の確率の係数が0なら、モデルは市場に何も足していない。
//   市場の係数が1・自分が0なら、市場が完全に正しく、モデルは無価値。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)

const pred = new Map()
for (const r of all(`SELECT race_id, lane, p, y FROM pred WHERE split='test'`)) {
  let g = pred.get(r.race_id); if (!g) { g = []; pred.set(r.race_id, g) }
  g.push(r)
}
const odds = new Map()
for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
  JOIN pred p ON p.race_id=o.race_id AND p.split='test' AND p.lane=1 WHERE o.odds IS NOT NULL`)) {
  let m = odds.get(r.race_id); if (!m) { m = new Map(); odds.set(r.race_id, m) }
  m.set(r.combo, r.odds)
}
console.log(`検証期間 ${pred.size.toLocaleString()} レース / オッズあり ${odds.size.toLocaleString()}`)

// ---------- 市場の1着確率を出す ----------
const boats = []       // {mp: 市場の1着確率, p: モデルの1着確率, y: 実際, lane, race_id}
const trioRows = []    // 3連単の組ごと {mp, p, odds, hit}
let takeoutSum = 0, takeoutN = 0
for (const [rid, bs] of pred) {
  const om = odds.get(rid); if (!om || om.size < 100) continue
  let tot = 0
  const raw = new Map()
  for (const [c, o] of om) { if (!o || o <= 0) continue; const v = 1 / o; raw.set(c, v); tot += v }
  if (tot <= 0) continue
  takeoutSum += 1 / tot; takeoutN++
  const first = new Array(7).fill(0)
  for (const [c, v] of raw) first[Number(c[0])] += v / tot
  const mp = new Map(bs.map((b) => [b.lane, first[b.lane]]))
  for (const b of bs) boats.push({ race_id: rid, lane: b.lane, p: b.p, mp: mp.get(b.lane) ?? 0, y: b.y })
  const pByLane = new Array(7).fill(0)
  for (const b of bs) pByLane[b.lane] = b.p
  for (const [c, o] of om) {
    const [a, b2, c3] = c.split('-').map(Number)
    const r1 = 1 - pByLane[a], r2 = 1 - pByLane[a] - pByLane[b2]
    if (r1 <= 1e-9 || r2 <= 1e-9) continue
    trioRows.push({ p: pByLane[a] * (pByLane[b2] / r1) * (pByLane[c3] / r2), mp: raw.get(c) / tot, odds: o, rid, combo: c })
  }
}
console.log(`平均払戻率（オッズ逆数の合計の逆数） ${(takeoutSum / takeoutN * 100).toFixed(1)}%  ＝控除率 ${(100 - takeoutSum / takeoutN * 100).toFixed(1)}%\n`)

// ---------- 1着予想：市場 vs モデル ----------
const ll = (rows, get) => -rows.reduce((a, r) => { const q = Math.min(Math.max(get(r), 1e-9), 1 - 1e-9); return a + (r.y ? Math.log(q) : Math.log(1 - q)) }, 0) / rows.length
console.log('=== 1着を当てる力（検証期間・艇単位） ===')
console.log(`  市場の確率   logloss ${ll(boats, (r) => r.mp).toFixed(4)}`)
console.log(`  モデルの確率 logloss ${ll(boats, (r) => r.p).toFixed(4)}`)

const acc = (key) => {
  const byRace = new Map()
  for (const b of boats) { let g = byRace.get(b.race_id); if (!g) { g = []; byRace.set(b.race_id, g) } g.push(b) }
  let hit = 0, n = 0
  for (const [, g] of byRace) { const best = g.reduce((a, b) => (b[key] > a[key] ? b : a)); if (best.y) hit++; n++ }
  return hit / n
}
console.log(`  市場が1番人気にした艇の的中率   ${(acc('mp') * 100).toFixed(2)}%`)
console.log(`  モデルが1位にした艇の的中率     ${(acc('p') * 100).toFixed(2)}%`)

// ---------- 決定的な検定：モデルは市場に何か足しているか ----------
// logit(実際) = a + b1*logit(市場) + b2*logit(モデル) を当てはめる
const lg = (q) => { const v = Math.min(Math.max(q, 1e-6), 1 - 1e-6); return Math.log(v / (1 - v)) }
function logistic(rows, feats) {
  const K = feats.length
  const w = new Float64Array(K + 1)
  const m = new Float64Array(K + 1), v = new Float64Array(K + 1)
  for (let ep = 1; ep <= 400; ep++) {
    const g = new Float64Array(K + 1)
    for (const r of rows) {
      let z = w[0]
      for (let k = 0; k < K; k++) z += w[k + 1] * feats[k](r)
      const q = 1 / (1 + Math.exp(-z))
      const d = q - r.y
      g[0] += d
      for (let k = 0; k < K; k++) g[k + 1] += d * feats[k](r)
    }
    for (let i = 0; i <= K; i++) {
      const gi = g[i] / rows.length
      m[i] = 0.9 * m[i] + 0.1 * gi
      v[i] = 0.999 * v[i] + 0.001 * gi * gi
      w[i] -= 0.05 * (m[i] / (1 - 0.9 ** ep)) / (Math.sqrt(v[i] / (1 - 0.999 ** ep)) + 1e-8)
    }
  }
  return w
}
console.log('\n=== モデルは市場に情報を足しているか ===')
console.log('  「実際に1着だったか」を 市場の見立て と モデルの見立て で説明させる')
const w1 = logistic(boats, [(r) => lg(r.mp)])
const w2 = logistic(boats, [(r) => lg(r.p)])
const w3 = logistic(boats, [(r) => lg(r.mp), (r) => lg(r.p)])
console.log(`  市場だけ            係数 ${w1[1].toFixed(3)}`)
console.log(`  モデルだけ          係数 ${w2[1].toFixed(3)}`)
console.log(`  両方入れたとき      市場 ${w3[1].toFixed(3)}  /  モデル ${w3[2].toFixed(3)}`)
console.log('  → 両方入れてモデルの係数が0近くなら、市場が既に知っていることしか見ていない')
console.log('  → モデルの係数が残るなら、市場が知らない情報を持っている')

// ---------- 市場のクセ（人気薄が買われすぎていないか） ----------
console.log('\n=== 市場のクセ：3連単の組を市場確率で分けて実際の的中率と比べる ===')
console.log('  市場確率帯          点数     市場平均   実際     ずれ      その帯を全部買った回収率')
const winCombo = new Map()
for (const r of all(`SELECT p.race_id, p.combo FROM payouts p
  JOIN pred q ON q.race_id=p.race_id AND q.split='test' AND q.lane=1 WHERE p.bet_type='sanrentan'`))
  winCombo.set(r.race_id, r.combo)
for (const t of trioRows) t.hit = winCombo.get(t.rid) === t.combo ? 1 : 0
const bands = [[0, 0.001], [0.001, 0.002], [0.002, 0.005], [0.005, 0.01], [0.01, 0.02],
  [0.02, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 1]]
for (const [lo, hi] of bands) {
  const s = trioRows.filter((t) => t.mp >= lo && t.mp < hi)
  if (s.length < 500) continue
  const mm = s.reduce((a, t) => a + t.mp, 0) / s.length
  const ac = s.reduce((a, t) => a + t.hit, 0) / s.length
  const roi = s.reduce((a, t) => a + t.hit * t.odds, 0) / s.length
  console.log(`  ${(lo * 100).toFixed(1)}〜${(hi * 100).toFixed(1)}%  ${String(s.length).padStart(9)}   ${(mm * 100).toFixed(2).padStart(6)}%  ${(ac * 100).toFixed(2).padStart(6)}%  ${((ac - mm) * 100).toFixed(2).padStart(6)}pt        ${(roi * 100).toFixed(1)}%`)
}
db.close()
