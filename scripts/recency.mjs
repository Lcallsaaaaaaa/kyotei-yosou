// 「直近の成績」は「昔の成績」より予測力があるか？
//
//   node scripts/recency.mjs
//
// ★問い
//   いまのモデルは選手の成績を全期間で平等に扱っている。
//   だが調子には波があるはずで、直近を重く見るべきかもしれない。
//   本当にそうなら、**古い期間の成績より新しい期間の成績の方が、将来をよく当てる**はず。
//
// ★測り方（モデルを学習させずに済む安い方法）
//   学習期間を「前半」と「後半」に割り、それぞれで選手×コースの1着率を出す。
//   その2つが、検証期間の実績をどれだけ言い当てるかを比べる。
//   後半（新しい方）の相関が明確に高ければ、直近を重く見る価値がある。
//   同じくらいなら、期間の重み付けは効果がない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const all = (s, ...p) => db.prepare(s).all(...p)

const MID = '2025-12-01'   // 学習期間の前半／後半の境
const SPLIT = '2026-02-18' // 検証期間の開始
const MIN_N = 15

const grab = (from, to) => {
  const m = new Map()
  for (const r of all(`SELECT e.racer_id, e.course c, COUNT(*) n, SUM(e.rank_num=1) w,
      SUM(e.rank_num<=3) t3
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND e.racer_id IS NOT NULL AND e.rank_num IS NOT NULL
      AND r.date >= ? AND r.date < ?
    GROUP BY e.racer_id, e.course HAVING n >= ?`, from, to, MIN_N))
    m.set(`${r.racer_id}:${r.c}`, { n: r.n, p1: r.w / r.n, p3: r.t3 / r.n })
  return m
}

const early = grab('2000-01-01', MID)       // 前半（古い）
const late = grab(MID, SPLIT)               // 後半（新しい）
const future = grab(SPLIT, '2100-01-01')    // 検証期間（答え）

console.log('=== 「直近の成績」は「昔の成績」より将来を当てるか ===\n')
console.log(`前半: 〜${MID}  /  後半: ${MID}〜${SPLIT}  /  答え: ${SPLIT}〜`)
console.log(`各期間で同一コース${MIN_N}走以上ある選手×コースのみ\n`)

const corr = (pairs) => {
  const n = pairs.length
  const mx = pairs.reduce((a, b) => a + b[0], 0) / n
  const my = pairs.reduce((a, b) => a + b[1], 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
  return sxy / Math.sqrt(sxx * syy)
}

for (const [label, key] of [['1着率', 'p1'], ['3連対率', 'p3']]) {
  const ePairs = [], lPairs = [], bothE = [], bothL = []
  for (const [k, f] of future) {
    const e = early.get(k), l = late.get(k)
    if (e) ePairs.push([e[key], f[key]])
    if (l) lPairs.push([l[key], f[key]])
    if (e && l) { bothE.push([e[key], f[key]]); bothL.push([l[key], f[key]]) }
  }
  console.log(`--- ${label} ---`)
  console.log(`  前半の成績 → 検証期間   相関 ${corr(ePairs).toFixed(4)}  (n=${ePairs.length})`)
  console.log(`  後半の成績 → 検証期間   相関 ${corr(lPairs).toFixed(4)}  (n=${lPairs.length})`)
  console.log(`  ※ 両方ある組だけで公平に比較:`)
  console.log(`     前半 ${corr(bothE).toFixed(4)}  vs  後半 ${corr(bothL).toFixed(4)}  (n=${bothE.length})`)
  const diff = corr(bothL) - corr(bothE)
  console.log(`     差 ${diff >= 0 ? '+' : ''}${diff.toFixed(4)} → ${Math.abs(diff) < 0.02 ? '**ほぼ差なし＝重み付けの価値は薄い**' : diff > 0 ? '**直近が有利＝重み付けに価値あり**' : '**昔の方が当たる（想定外）**'}\n`)
}

// 参考：前半と後半を足した方が良いのか
console.log('--- 参考：前半＋後半を合算した場合 ---')
const both = [], lateOnly = []
for (const [k, f] of future) {
  const e = early.get(k), l = late.get(k)
  if (!e || !l) continue
  const merged = (e.p1 * e.n + l.p1 * l.n) / (e.n + l.n)
  both.push([merged, f.p1])
  lateOnly.push([l.p1, f.p1])
}
console.log(`  合算 → 検証期間   相関 ${corr(both).toFixed(4)}`)
console.log(`  後半のみ          相関 ${corr(lateOnly).toFixed(4)}`)
console.log(`  → 合算の方が高ければ、**古いデータも捨てずに使うべき**（標本数が効く）`)
db.close()
