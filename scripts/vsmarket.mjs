// モデルは市場（オッズ）より正確に1着を読めているか。
//
//   node --max-old-space-size=8192 scripts/vsmarket.mjs
//
// ★これが本丸
//   オッズは投票の結果であって原因ではない。買って勝てるかどうかは
//   結局「モデルが市場より正確か」に還元される。
//   市場のほうが正確なら、どんな買い方をしても控除率の内側から出られない。
//   モデルが正確なら、取り出し方の問題になる。
//
// ★市場の予測確率の作り方
//   確定オッズの逆数 1/o が「賭け金のシェア」。Σ(1/o) は控除前で1を超える（実測1.36）。
//   Σで割って正規化すると、市場が思っている1着確率になる。
//
// ★評価
//   ブライアスコア（小さいほど良い）と対数損失。
//   どちらも「確率をどれだけ正確に言えたか」を測る。的中率では測れない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')

// モデルの予測
const M = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()) {
  let a = M.get(r.race_id); if (!a) { a = new Map(); M.set(r.race_id, a) }
  a.set(r.lane, { p: r.p, y: r.y })
}
// 市場の予測（確定オッズから）
const O = new Map()
for (const r of db.prepare(`SELECT race_id,lane,tansho FROM odds_tan WHERE tansho>0`).all()) {
  let a = O.get(r.race_id); if (!a) { a = new Map(); O.set(r.race_id, a) }
  a.set(r.lane, r.tansho)
}
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,jcd FROM races`).all()) RC.set(r.race_id, r.jcd)

const rows = []
for (const [rid, m] of M) {
  const o = O.get(rid); if (!o || o.size !== 6 || m.size !== 6) continue
  const sum = [...o.values()].reduce((a, x) => a + 1 / x, 0)
  if (sum < 1.15 || sum > 1.60) continue          // 異常なオッズは除く
  for (const [lane, v] of m) {
    const od = o.get(lane); if (!od) continue
    rows.push({ rid, jcd: RC.get(rid), lane, p: v.p, q: (1 / od) / sum, y: v.y })
  }
}
console.log(`突き合わせ ${(rows.length / 6).toLocaleString()}レース（${rows.length.toLocaleString()}艇）\n`)

const brier = (f) => rows.reduce((a, r) => a + (f(r) - r.y) ** 2, 0) / rows.length
const logloss = (f) => -rows.reduce((a, r) => {
  const p = Math.min(0.999999, Math.max(0.000001, f(r)))
  return a + (r.y ? Math.log(p) : Math.log(1 - p))
}, 0) / rows.length

console.log('════ ① 全体：どちらが正確か ════')
console.log('                       ブライア      対数損失')
const bm = brier((r) => r.p), bq = brier((r) => r.q)
const lm = logloss((r) => r.p), lq = logloss((r) => r.q)
console.log(`  モデル              ${bm.toFixed(5)}      ${lm.toFixed(5)}`)
console.log(`  市場（確定オッズ）    ${bq.toFixed(5)}      ${lq.toFixed(5)}`)
console.log(`  → ${bm < bq ? '★モデルの勝ち' : '市場の勝ち'}（ブライア差 ${((bq - bm) * 1000).toFixed(2)}／1000）`)
console.log(`  → ${lm < lq ? '★モデルの勝ち' : '市場の勝ち'}（対数損失差 ${(lq - lm).toFixed(5)}）`)

// 半々で混ぜたら
for (const w of [0.25, 0.5, 0.75]) {
  const b = brier((r) => w * r.p + (1 - w) * r.q)
  console.log(`  モデル${(w * 100).toFixed(0)}%＋市場${((1 - w) * 100).toFixed(0)}%  ${b.toFixed(5)}${b < Math.min(bm, bq) ? '  ★混ぜたほうが良い＝互いに別の情報を持っている' : ''}`)
}

console.log('\n════ ② 艇番ごと：どこで負けているか ════')
console.log(' 艇番   モデル      市場       差（＋＝モデルが良い）')
for (let L = 1; L <= 6; L++) {
  const s = rows.filter((r) => r.lane === L)
  const b1 = s.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / s.length
  const b2 = s.reduce((a, r) => a + (r.q - r.y) ** 2, 0) / s.length
  console.log(`  ${L}号艇 ${b1.toFixed(5)}   ${b2.toFixed(5)}   ${((b2 - b1) * 1000).toFixed(2).padStart(7)}${b1 < b2 ? '  ★モデル' : '  市場'}`)
}

console.log('\n════ ③ モデルと市場が食い違ったとき、どちらが正しいか ════')
console.log('（レースごとに、それぞれが最有力とした艇を比べる）')
const byRace = new Map()
for (const r of rows) { let a = byRace.get(r.rid); if (!a) { a = []; byRace.set(r.rid, a) } a.push(r) }
let same = 0, diff = 0, mWin = 0, qWin = 0, both = 0
const gap = []
for (const [, a] of byRace) {
  if (a.length !== 6) continue
  const mf = a.reduce((x, y) => (y.p > x.p ? y : x))
  const qf = a.reduce((x, y) => (y.q > x.q ? y : x))
  if (mf.lane === qf.lane) { same++; if (mf.y) both++; continue }
  diff++
  if (mf.y) mWin++; if (qf.y) qWin++
  gap.push({ ratio: mf.p / mf.q, mHit: mf.y, qHit: qf.y })
}
console.log(`  一致 ${same.toLocaleString()}レース（そのとき的中 ${(both / same * 100).toFixed(1)}%）`)
console.log(`  食い違い ${diff.toLocaleString()}レース  モデルの本命が1着 ${(mWin / diff * 100).toFixed(1)}%  市場の本命が1着 ${(qWin / diff * 100).toFixed(1)}%`)
console.log(`  → ${mWin > qWin ? '★モデルの勝ち' : '市場の勝ち'}`)

console.log('\n  乖離の大きさ別（モデルの確率 ÷ 市場の確率）')
console.log('  乖離        レース数   モデル的中   市場的中   勝者')
for (const [lo, hi] of [[1, 1.5], [1.5, 2], [2, 3], [3, 5], [5, 999]]) {
  const s = gap.filter((x) => x.ratio >= lo && x.ratio < hi)
  if (s.length < 100) continue
  const m = s.filter((x) => x.mHit).length / s.length
  const q2 = s.filter((x) => x.qHit).length / s.length
  console.log(`  ${lo}〜${hi === 999 ? '∞' : hi}倍 ${String(s.length).padStart(12)} ${(m * 100).toFixed(1).padStart(10)}% ${(q2 * 100).toFixed(1).padStart(9)}%   ${m > q2 ? '★モデル' : '市場'}`)
}
db.close()
