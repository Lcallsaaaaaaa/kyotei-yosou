// 「本番のSTは事前に予測できるのか」を測る。
//
// geometry.mjs で、本番のST差が1マークの結果をほぼ決めることが分かった
// （1コース1着率は ST差だけで 80%→3.8% まで動く）。
// だが本番STはレース後にしか分からない。事前に使えるのは「選手の平均ST実績」だけ。
// **その代理変数がどれだけ本番STを言い当てるのか**が、幾何を予想に使えるかの分かれ目になる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const SPLIT = '2026-02-18'

// 学習期間の選手×コース別 平均ST
const exp = new Map()
for (const r of all(`SELECT e.racer_id, e.course c,
    AVG(e.st) st, COUNT(*) n
  FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND e.st IS NOT NULL AND e.st_flag IS NULL
    AND e.racer_id IS NOT NULL AND r.date < ?
  GROUP BY e.racer_id, e.course HAVING n >= 10`, SPLIT)) {
  exp.set(`${r.racer_id}:${r.c}`, r.st)
}
const courseAvg = {}
for (const r of all(`SELECT e.course c, AVG(e.st) st FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND e.st IS NOT NULL AND e.st_flag IS NULL AND r.date < ? GROUP BY e.course`, SPLIT)) {
  courseAvg[r.c] = r.st
}

// 検証期間で答え合わせ
const rows = all(`SELECT e.racer_id, e.course c, e.st FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND e.st IS NOT NULL AND e.st_flag IS NULL
    AND e.racer_id IS NOT NULL AND r.date >= ?`, SPLIT)

const pairs = []
for (const r of rows) {
  const p = exp.get(`${r.racer_id}:${r.c}`)
  if (p == null) continue
  pairs.push([p, r.st])
}
const n = pairs.length
const mx = pairs.reduce((a, b) => a + b[0], 0) / n
const my = pairs.reduce((a, b) => a + b[1], 0) / n
let sxy = 0, sxx = 0, syy = 0
for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
const r = sxy / Math.sqrt(sxx * syy)

console.log('=== 「選手の平均ST」は「本番のST」をどれだけ言い当てるか ===\n')
console.log(`  対象 ${n.toLocaleString()} 件（学習期間に同コース10走以上ある選手のみ）`)
console.log(`  相関係数 r = ${r.toFixed(4)}   決定係数 R² = ${(r * r).toFixed(4)}`)
console.log(`  → 本番STのばらつきのうち、平均STで説明できるのは **${(r * r * 100).toFixed(1)}%** だけ`)

// 予測誤差
const rmse = Math.sqrt(pairs.reduce((a, [x, y]) => a + (x - y) ** 2, 0) / n)
const sdY = Math.sqrt(syy / n)
console.log(`\n  本番STの標準偏差      : ${sdY.toFixed(4)}秒  (= ${(sdY * 16).toFixed(2)}m)`)
console.log(`  平均STで予測した誤差  : ${rmse.toFixed(4)}秒  (= ${(rmse * 16).toFixed(2)}m)`)
console.log(`  ※ geometry.mjs の実測では、1マークの勝敗を分けるST差は 0.057秒(0.9m) 前後。`)
console.log(`  ※ 予測誤差がその水準を超えていれば、平均STから勝敗は読めない。`)

// レース単位で「予測したST順位」と「実際のST順位」の一致度
const raceRows = all(`SELECT e.race_id, e.racer_id, e.course c, e.st FROM entries e
  JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND e.st IS NOT NULL AND e.st_flag IS NULL
    AND e.racer_id IS NOT NULL AND r.date >= ? ORDER BY e.race_id`, SPLIT)
const byRace = new Map()
for (const x of raceRows) {
  if (!byRace.has(x.race_id)) byRace.set(x.race_id, [])
  byRace.get(x.race_id).push(x)
}
let hit = 0, tot = 0
for (const [, bs] of byRace) {
  if (bs.length !== 6) continue
  const pred = bs.map((b) => ({ c: b.c, p: exp.get(`${b.racer_id}:${b.c}`) ?? courseAvg[b.c] }))
  const predBest = pred.slice().sort((a, b) => a.p - b.p)[0].c
  const actBest = bs.slice().sort((a, b) => a.st - b.st)[0].c
  tot++
  if (predBest === actBest) hit++
}
console.log(`\n  「そのレースで最も速くスタートを切る艇」の的中率: ${((hit / tot) * 100).toFixed(1)}%  (n=${tot.toLocaleString()})`)
console.log(`  ※ 当てずっぽうなら 16.7%。`)
db.close()
