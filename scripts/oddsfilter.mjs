// 「オッズが安すぎるレースは見送る」と回収率がどうなるかを調べる。
//
//   node scripts/oddsfilter.mjs
//   node scripts/oddsfilter.mjs --t3 wc3     条件付きモデルで見る
//
// ★考え方
//   回収率 = 的中率 × 平均オッズ。自信のあるレースに絞ると的中率は上がるが、
//   そういうレースはオッズも安い。だから回収率が動かなかった。
//   なら「自信があって、かつオッズがそれなりに付く」レースだけ選べばよいのでは、という発想。
//
// ★選択バイアスに注意
//   条件の組み合わせを大量に試して良いものを選ぶと、必ず良い数字が出る。
//   実際それで「回収率279%」という誤りを出した。
//   だからここでは **先の月で条件を決め、後の月で確かめる**。
//   後の月で崩れたら、その条件は使えない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T3 = flag('t3', 'walk3')
const NPICK = Number(flag('n', 5))
console.log(`モデル: ${T3}  3連単${NPICK}点買い`)

const win = new Map()
for (const r of all(`SELECT race_id, combo FROM payouts WHERE bet_type='sanrentan'`)) win.set(r.race_id, r.combo)

// オッズと予想を突き合わせる
const races = []
{
  const odds = new Map()
  for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
    WHERE o.odds IS NOT NULL AND EXISTS (SELECT 1 FROM ${T3} w WHERE w.race_id=o.race_id)`)) {
    let m = odds.get(r.race_id); if (!m) { m = new Map(); odds.set(r.race_id, m) }
    m.set(r.combo, r.odds)
  }
  const mdl = new Map()
  for (const r of all(`SELECT race_id, combo, p, month FROM ${T3}`)) {
    let g = mdl.get(r.race_id); if (!g) { g = { month: r.month, c: new Map() }; mdl.set(r.race_id, g) }
    g.c.set(r.combo, r.p)
  }
  for (const [rid, om] of odds) {
    const g = mdl.get(rid); if (!g || om.size < 100) continue
    const tot = [...g.c.values()].reduce((a, b) => a + b, 0)
    const cand = [...g.c].map(([c, p]) => ({ c, p: p / tot, o: om.get(c) })).filter((x) => x.o != null)
    if (cand.length < 100) continue
    cand.sort((a, b) => b.p - a.p)
    const picks = cand.slice(0, NPICK)
    const w = win.get(rid)
    races.push({
      rid, month: g.month,
      conf: picks.reduce((a, x) => a + x.p, 0),          // 買い目全体の的中確率
      minOdds: Math.min(...picks.map((x) => x.o)),        // いちばん安い買い目
      maxOdds: Math.max(...picks.map((x) => x.o)),
      // 当たったときに戻る期待額（確率で重み付け）÷ 購入額。1.0を超えれば理屈上は勝てる
      ev: picks.reduce((a, x) => a + x.p * x.o, 0) / NPICK,
      cost: NPICK * 100,
      back: picks.some((x) => x.c === w) ? (picks.find((x) => x.c === w).o * 100) : 0,
      hit: picks.some((x) => x.c === w) ? 1 : 0,
    })
  }
}
const months = [...new Set(races.map((r) => r.month))].sort()
console.log(`${races.length.toLocaleString()}レース  月: ${months.join(' / ')}\n`)

const stat = (a) => {
  if (!a.length) return null
  const cost = a.reduce((x, r) => x + r.cost, 0), back = a.reduce((x, r) => x + r.back, 0)
  return { n: a.length, hit: a.reduce((x, r) => x + r.hit, 0) / a.length, roi: back / cost, pl: (back - cost) / a.length }
}

// ---------- 探索：前半の月で、どの条件が良いかを見る ----------
const half = Math.floor(months.length / 2)
const early = races.filter((r) => months.indexOf(r.month) < half)
const late = races.filter((r) => months.indexOf(r.month) >= half)
console.log(`探索に使う月: ${months.slice(0, half).join(',')}（${early.length.toLocaleString()}レース）`)
console.log(`確認に使う月: ${months.slice(half).join(',')}（${late.length.toLocaleString()}レース）\n`)

console.log('=== 探索：自信 × 最低オッズ で切ったときの回収率（前半の月） ===')
console.log('  自信下限   最低オッズ下限    レース数   的中率   回収率')
const CONFS = [0, 0.2, 0.3, 0.4, 0.5]
const ODDS = [0, 5, 10, 15, 20, 30, 50]
const found = []
for (const cf of CONFS) for (const od of ODDS) {
  const s = stat(early.filter((r) => r.conf >= cf && r.minOdds >= od))
  if (!s || s.n < 200) continue
  found.push({ cf, od, ...s })
  console.log(`  ${(cf * 100).toFixed(0).padStart(5)}%   ${String(od).padStart(6)}倍以上   ${String(s.n).padStart(7)}   ${(s.hit * 100).toFixed(1).padStart(5)}%   ${(s.roi * 100).toFixed(1).padStart(6)}%`)
}

console.log('\n=== 探索：期待値で切った場合（前半の月） ===')
console.log('  期待値下限   レース数   的中率   回収率')
for (const ev of [0, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0]) {
  const s = stat(early.filter((r) => r.ev >= ev))
  if (!s || s.n < 100) continue
  console.log(`  ${ev.toFixed(2).padStart(8)}   ${String(s.n).padStart(7)}   ${(s.hit * 100).toFixed(1).padStart(5)}%   ${(s.roi * 100).toFixed(1).padStart(6)}%`)
}

// ---------- 確認：前半でいちばん良かった条件を、後半の月に当てる ----------
found.sort((a, b) => b.roi - a.roi)
console.log('\n=== 確認：前半で成績の良かった条件を後半の月に当てる ===')
console.log('  条件                          前半の回収率 → 後半の回収率   後半のレース数  後半の的中率')
for (const f of found.slice(0, 6)) {
  const s = stat(late.filter((r) => r.conf >= f.cf && r.minOdds >= f.od))
  if (!s) continue
  const mark = s.roi >= 1 ? ' ★100%超' : ''
  console.log(`  自信${(f.cf * 100).toFixed(0)}%以上・最低${f.od}倍以上   ${(f.roi * 100).toFixed(1).padStart(6)}% → ${(s.roi * 100).toFixed(1).padStart(6)}%   ${String(s.n).padStart(7)}      ${(s.hit * 100).toFixed(1)}%${mark}`)
}

// ---------- 参考：オッズ帯そのものの成績（全期間） ----------
console.log('\n=== 参考：買い目の最低オッズ帯ごとの成績（全期間） ===')
console.log('  最低オッズ    レース数   的中率   回収率   1本あたり収支')
for (const [lo, hi] of [[0, 5], [5, 10], [10, 20], [20, 40], [40, 80], [80, 1e9]]) {
  const s = stat(races.filter((r) => r.minOdds >= lo && r.minOdds < hi))
  if (!s || s.n < 100) continue
  console.log(`  ${String(lo).padStart(4)}〜${hi === 1e9 ? ' ∞' : String(hi).padStart(3)}倍   ${String(s.n).padStart(7)}   ${(s.hit * 100).toFixed(1).padStart(5)}%   ${(s.roi * 100).toFixed(1).padStart(6)}%   ${(s.pl >= 0 ? '+' : '') + s.pl.toFixed(0).padStart(5)}円`)
}
console.log('\n※ 前半で良くても後半で崩れる条件は使えない。偶然を拾っただけ。')
db.close()
