// 「確率帯のどこにモデルの優位があるか」を測る。
//
//   node scripts/band.mjs
//
// ★仮説（ユーザー提案）
//   的中40〜60%の帯は、オッズが1.7〜2.5倍つく。
//   回収率 = 的中率 × オッズ なので、この帯で精度を上げれば効きが大きいはず。
//   逆に的中86%の帯はオッズ1.15倍しかなく、伸ばしても回収率は動かない。
//
// ★確かめること
//   1. 帯ごとに、モデルと市場のどちらが正確か（対数損失で比較）
//   2. 帯ごとに、モデルの本命を買ったときの回収率
//   3. モデルと市場が食い違ったとき、どちらが正しいか（帯別）
//   3が本題。市場より正しい帯があれば、そこだけ買えばよい。
//
// ★注意
//   帯を細かく切って良い数字を探すと、必ず偶然が混ざる。
//   前半の月で見つけた傾向が後半の月でも出るかを必ず確認する。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'wd1')

// モデルの1着確率・単勝オッズ・結果を艇単位で集める
const rows = all(`
  SELECT w.race_id, w.lane, w.month, w.p, w.y, t.tansho AS odds
  FROM ${T1} w
  JOIN odds_tan t ON t.race_id = w.race_id AND t.lane = w.lane
  WHERE t.tansho IS NOT NULL AND t.tansho > 0`)
console.log(`${rows.length.toLocaleString()} 艇ぶん（${new Set(rows.map((r) => r.race_id)).size.toLocaleString()}レース）`)

// 市場の確率＝オッズ逆数をレース内で正規化
const byRace = new Map()
for (const r of rows) { let g = byRace.get(r.race_id); if (!g) { g = []; byRace.set(r.race_id, g) } g.push(r) }
for (const [, g] of byRace) {
  const tot = g.reduce((a, x) => a + 1 / x.odds, 0)
  for (const x of g) x.mp = (1 / x.odds) / tot
}
const months = [...new Set(rows.map((r) => r.month))].sort()
const half = Math.floor(months.length / 2)
const isEarly = (r) => months.indexOf(r.month) < half
console.log(`月: ${months.join(' ')}  前半=${months.slice(0, half).join(',')} / 後半=${months.slice(half).join(',')}\n`)

const ll = (a, get) => -a.reduce((s, r) => {
  const q = Math.min(Math.max(get(r), 1e-9), 1 - 1e-9)
  return s + (r.y ? Math.log(q) : Math.log(1 - q))
}, 0) / a.length

// ---------- 1. モデル確率の帯ごと ----------
console.log('=== モデルが「この艇が1着」と見た確率の帯ごと ===')
console.log('  帯          艇数    実際の1着率  平均オッズ  回収率   市場logloss  モデルlogloss  勝者')
const BANDS = [[0, .1], [.1, .2], [.2, .3], [.3, .4], [.4, .5], [.5, .6], [.6, .7], [.7, .8], [.8, .9], [.9, 1]]
for (const [lo, hi] of BANDS) {
  const s = rows.filter((r) => r.p >= lo && r.p < hi)
  if (s.length < 200) continue
  const hit = s.reduce((a, r) => a + r.y, 0) / s.length
  const ret = s.reduce((a, r) => a + r.y * r.odds, 0) / s.length
  const lm = ll(s, (r) => r.mp), lo2 = ll(s, (r) => r.p)
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}〜${(hi * 100).toFixed(0).padStart(3)}%  ${String(s.length).padStart(7)}    ${(hit * 100).toFixed(1).padStart(5)}%    ${(s.reduce((a, r) => a + r.odds, 0) / s.length).toFixed(2).padStart(6)}   ${(ret * 100).toFixed(1).padStart(6)}%   ${lm.toFixed(4)}     ${lo2.toFixed(4)}    ${lo2 < lm ? 'モデル' : '市場'}`)
}

// ---------- 2. モデルと市場が食い違ったとき ----------
console.log('\n=== モデルと市場の見立てが食い違ったとき、どちらが正しいか ===')
console.log('  モデル確率帯   食い違い幅   艇数   実際   モデル予想  市場予想  回収率')
for (const [lo, hi] of [[.2, .4], [.4, .6], [.6, .8], [.8, 1]]) {
  for (const [dlo, dhi] of [[.05, .1], [.1, .2], [.2, 1]]) {
    const s = rows.filter((r) => r.p >= lo && r.p < hi && r.p - r.mp >= dlo && r.p - r.mp < dhi)
    if (s.length < 150) continue
    const hit = s.reduce((a, r) => a + r.y, 0) / s.length
    const ret = s.reduce((a, r) => a + r.y * r.odds, 0) / s.length
    console.log(`  ${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}%      +${(dlo * 100).toFixed(0)}〜${(dhi * 100).toFixed(0)}pt   ${String(s.length).padStart(6)}  ${(hit * 100).toFixed(1).padStart(5)}%    ${(s.reduce((a, r) => a + r.p, 0) / s.length * 100).toFixed(1).padStart(5)}%    ${(s.reduce((a, r) => a + r.mp, 0) / s.length * 100).toFixed(1).padStart(5)}%   ${(ret * 100).toFixed(1).padStart(6)}%`)
  }
}

// ---------- 3. 帯ごとに買った場合の回収率（前半・後半で再現するか） ----------
console.log('\n=== モデル確率帯ごとに単勝を買った場合（前半→後半の再現性） ===')
console.log('  帯          全体艇数  全体回収  前半回収  後半回収  判定')
for (const [lo, hi] of BANDS) {
  const s = rows.filter((r) => r.p >= lo && r.p < hi)
  if (s.length < 300) continue
  const R = (a) => (a.length ? a.reduce((x, r) => x + r.y * r.odds, 0) / a.length : 0)
  const e = s.filter(isEarly), l = s.filter((r) => !isEarly(r))
  const ok = R(e) >= 1 && R(l) >= 1
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}〜${(hi * 100).toFixed(0).padStart(3)}%  ${String(s.length).padStart(8)}  ${(R(s) * 100).toFixed(1).padStart(7)}%  ${(R(e) * 100).toFixed(1).padStart(7)}%  ${(R(l) * 100).toFixed(1).padStart(7)}%  ${ok ? '★両方100%超' : ''}`)
}

// ---------- 4. オッズ帯で切った場合 ----------
console.log('\n=== 単勝オッズの帯ごと（モデル本命のみ） ===')
console.log('  オッズ帯     艇数   モデル予想  実際   回収率  前半回収  後半回収')
const tops = []
for (const [, g] of byRace) tops.push(g.reduce((a, b) => (b.p > a.p ? b : a)))
for (const [lo, hi] of [[1, 1.3], [1.3, 1.6], [1.6, 2], [2, 2.5], [2.5, 3.5], [3.5, 5], [5, 100]]) {
  const s = tops.filter((r) => r.odds >= lo && r.odds < hi)
  if (s.length < 150) continue
  const R = (a) => (a.length ? a.reduce((x, r) => x + r.y * r.odds, 0) / a.length : 0)
  const e = s.filter(isEarly), l = s.filter((r) => !isEarly(r))
  console.log(`  ${lo.toFixed(1)}〜${hi === 100 ? ' ∞' : hi.toFixed(1)}倍  ${String(s.length).padStart(6)}   ${(s.reduce((a, r) => a + r.p, 0) / s.length * 100).toFixed(1).padStart(5)}%  ${(s.reduce((a, r) => a + r.y, 0) / s.length * 100).toFixed(1).padStart(5)}%  ${(R(s) * 100).toFixed(1).padStart(6)}%  ${(R(e) * 100).toFixed(1).padStart(7)}%  ${(R(l) * 100).toFixed(1).padStart(7)}%`)
}
console.log('\n※ 前半と後半の両方で100%を超えないものは採用しない')
db.close()
