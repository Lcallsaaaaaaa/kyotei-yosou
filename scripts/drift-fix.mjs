// 締切前オッズを割り引いて判定したら、単勝の判定は生き返るか。
//   node --max-old-space-size=8192 scripts/drift-fix.mjs
//
// ★何が起きているか（2026-08-31に判明）
//   単勝は総取り式なので、**買うときのオッズは目安で、払戻は締切後に決まる**。
//   いまの判定は「締切前オッズ >= (1÷確率)×余裕」で買う。これは
//   「たまたま高く表示されている艇」を選ぶことになり、その表示は締切までに下がる。
//     全候補       確定÷締切前 の中央値 1.000（偏りなし）
//     買うと決めた分                0.495（85.6%が下がる）
//   つまり必要倍率を満たしたつもりでも、実際の払戻はその半分。
//   9日ぶんの実測で 締切前判定 83.4% / 確定オッズ判定 111.0%。
//
// ★試すこと
//   締切前オッズに割引率 k を掛けてから判定する。
//     判定式: live * k >= (1 ÷ 確率) × 余裕
//   k を下げるほど「よほど高くないと買わない」ようになる。
//   選び直した買い目で、確定の払戻がプラスになる k があるかを見る。
//
// ⚠ 9日ぶんしかない。ここで良い k が見つかっても、それは仮説であって結論ではない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
const LIVE = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho, mins_before FROM odds_live
    WHERE tansho IS NOT NULL AND mins_before IS NOT NULL ORDER BY mins_before DESC`).iterate())
  LIVE.set(r.race_id + '|' + r.lane, r.tansho)
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1`).iterate())
  WIN.set(r.race_id, r.lane)
const CAL = loadCalib(db, 'wi1')

const rows = []
for (const f of readdirSync(join(ROOT, 'data')).filter((x) => /^predict-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'))
  for (const r of (j.races ?? [])) {
    const win = WIN.get(r.race_id); if (win == null) continue
    for (const b of (r.first ?? [])) {
      const k = r.race_id + '|' + b.lane
      const fin = OD.get(k), lv = LIVE.get(k)
      if (!(fin > 0) || !lv) continue
      rows.push({ id: r.race_id, lane: b.lane, p: b.p, fin, live: lv,
        y: win === b.lane ? 1 : 0, day: r.race_id.slice(0, 8) })
    }
  }
}
const DAYS = new Set(rows.map((r) => r.day)).size
console.log(`候補 ${rows.length.toLocaleString()}本（${DAYS}日）\n`)

function run(k, th = 0) {
  let n = 0, hit = 0, ret = 0, ratio = []
  const per = new Map()
  for (const r of rows) {
    const p = calibrate(CAL, r.p, r.live)
    if (p < th) continue
    if (r.live * k < (1 / p) * S.MARGIN) continue
    n++; ratio.push(r.fin / r.live)
    const g = r.y === 1 ? (PAY.get(r.id + '|' + r.lane) ?? r.fin * 100) : 0
    if (r.y === 1) hit++
    ret += g
    let a = per.get(r.day); if (!a) { a = { n: 0, g: 0 }; per.set(r.day, a) }
    a.n++; a.g += g
  }
  const md = ratio.length ? ratio.slice().sort((a, b) => a - b)[Math.floor(ratio.length / 2)] : 0
  return { n, hit, roi: n ? ret / (n * 100) * 100 : 0, pl: ret - n * 100, md,
    pos: [...per.values()].filter((a) => a.g > a.n * 100).length, days: per.size }
}
console.log('【締切前オッズに割引率 k を掛けてから判定】')
console.log('   k     本数   1日   的中率   回収率      損益  確定÷締切前  プラスの日')
for (const k of [1.0, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2]) {
  const a = run(k); if (!a.n) continue
  console.log(`  ${k.toFixed(2)} ${String(a.n).padStart(7)} ${(a.n / DAYS).toFixed(1).padStart(6)} ` +
    `${(a.hit / a.n * 100).toFixed(2).padStart(7)}% ${a.roi.toFixed(1).padStart(7)}% ` +
    `${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} ${a.md.toFixed(3).padStart(11)} ${a.pos}/${a.days}`)
}
console.log('\n【いちばん良かった k で、確率の足切りも変えてみる】')
let best = null
for (const k of [1.0, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2]) {
  const a = run(k); if (a.n >= 50 && (!best || a.roi > best.a.roi)) best = { k, a }
}
if (best) {
  console.log(`  k=${best.k}`)
  console.log('  足切り    本数   1日   的中率   回収率      損益  プラスの日')
  for (const th of [0, 0.05, 0.10, 0.15, 0.30]) {
    const a = run(best.k, th); if (!a.n) continue
    console.log(`  ${(th * 100).toFixed(0).padStart(3)}%以上 ${String(a.n).padStart(6)} ${(a.n / DAYS).toFixed(1).padStart(6)} ` +
      `${(a.hit / a.n * 100).toFixed(2).padStart(7)}% ${a.roi.toFixed(1).padStart(7)}% ` +
      `${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} ${a.pos}/${a.days}`)
  }
}
console.log(`\n⚠ ${DAYS}日ぶんしかない。良い k が出ても仮説であって結論ではない。`)
db.close()
