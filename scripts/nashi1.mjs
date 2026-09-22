// 「1号艇を必ず入れる」のをやめると回収率がどうなるかを測る。
//
//   node scripts/nashi1.mjs
//
// ★ユーザーの指摘
//   1号艇の3連対率が高いなら、全買い目に1号艇を入れても情報がない。
//   誰でもそう買うのでオッズが潰れる。
//   価値があるのは「1号艇が来ない」を当てられる場面のはず。
//
//   これは単勝で見つけた構造と同じ。市場が正しく織り込んでいる所ではなく、
//   市場が外している所にしか優位はない。
//
// ★確かめること
//   1. 1号艇の実際の3連対率と、モデルの読みの精度
//   2. モデルが「1号艇が飛ぶ」と見たとき、実際どれだけ飛ぶか
//   3. 1号艇を外した3連複の回収率（含める場合との比較）
//   4. 前半・後半で再現するか

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T3 = flag('t3', 'we3')

// 3連複の的中組と払戻
const winF = new Map()
for (const r of all(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku'`))
  winF.set(r.race_id, { combo: r.combo, amt: r.amount })

// 3連複オッズ
const oddsF = new Map()
for (const r of all(`SELECT race_id, combo, odds FROM odds3f WHERE odds IS NOT NULL`)) {
  let m = oddsF.get(r.race_id); if (!m) { m = new Map(); oddsF.set(r.race_id, m) }
  m.set(r.combo, r.odds)
}

// モデルの3連単確率 → 3連複に畳む
const races = []
{
  const m = new Map()
  for (const r of all(`SELECT race_id, combo, p, month FROM ${T3}`)) {
    let g = m.get(r.race_id); if (!g) { g = { month: r.month, rows: [] }; m.set(r.race_id, g) }
    g.rows.push(r)
  }
  for (const [rid, g] of m) {
    if (g.rows.length < 100 || !winF.has(rid) || !oddsF.has(rid)) continue
    const tot = g.rows.reduce((a, x) => a + x.p, 0)
    const box = new Map()
    let p1in = 0   // 1号艇が3着以内に入る確率
    for (const x of g.rows) {
      const s = x.combo.split('-').map(Number)
      const k = [...s].sort((a, b) => a - b).join('-')
      const p = x.p / tot
      box.set(k, (box.get(k) ?? 0) + p)
      if (s.includes(1)) p1in += p
    }
    const w = winF.get(rid)
    races.push({ rid, month: g.month, box, p1in,
      win: w.combo, amt: w.amt, odds: oddsF.get(rid),
      won1: w.combo.split('-').map(Number).includes(1) })
  }
}
const months = [...new Set(races.map((r) => r.month))].sort()
const half = Math.floor(months.length / 2)
const isE = (r) => months.indexOf(r.month) < half
console.log(`${races.length.toLocaleString()}レース  月 ${months.join(' ')}\n`)

// ---------- 1. 1号艇の3連対率とモデルの精度 ----------
const act1 = races.filter((r) => r.won1).length / races.length
const pred1 = races.reduce((a, r) => a + r.p1in, 0) / races.length
console.log('=== 1号艇が3着以内に入る率 ===')
console.log(`  実際 ${(act1 * 100).toFixed(1)}%   モデルの読み ${(pred1 * 100).toFixed(1)}%   ずれ ${((act1 - pred1) * 100).toFixed(1)}pt\n`)

console.log('=== モデルが「1号艇が3着以内」と見た確率の帯ごと ===')
console.log('  帯          レース数   実際の3連対率  ずれ')
for (const [lo, hi] of [[0, .5], [.5, .6], [.6, .7], [.7, .8], [.8, .85], [.85, .9], [.9, .95], [.95, 1]]) {
  const s = races.filter((r) => r.p1in >= lo && r.p1in < hi)
  if (s.length < 200) continue
  const a = s.filter((r) => r.won1).length / s.length
  const p = s.reduce((x, r) => x + r.p1in, 0) / s.length
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}〜${(hi * 100).toFixed(0).padStart(3)}%  ${String(s.length).padStart(8)}     ${(a * 100).toFixed(1).padStart(5)}%     ${((a - p) * 100).toFixed(1).padStart(5)}pt`)
}

// ---------- 2. 買い方の比較 ----------
const stat = (rows) => {
  if (!rows.length) return null
  const cost = rows.reduce((a, r) => a + r.n * 100, 0)
  const back = rows.reduce((a, r) => a + r.back, 0)
  return { n: rows.length, hit: rows.filter((r) => r.back > 0).length / rows.length, roi: back / cost, pl: (back - cost) / rows.length }
}
/** 買い目を選ぶ。filt で組を絞り、上位n点 */
function build(pick, n, filt) {
  const out = []
  for (const r of races) {
    let cand = [...r.box].sort((a, b) => b[1] - a[1])
    if (filt) cand = cand.filter(([c]) => filt(c.split('-').map(Number), r))
    cand = cand.slice(0, n)
    if (!cand.length) continue
    const back = cand.some(([c]) => c === r.win) ? r.amt : 0
    out.push({ rid: r.rid, month: r.month, n: cand.length, back,
      conf: cand.reduce((a, x) => a + x[1], 0), p1in: r.p1in, won1: r.won1 })
  }
  return out
}

console.log('\n=== 買い方の比較（3連複3点・全レース） ===')
console.log('  買い方                     レース数  的中率   回収率   1本収支')
const A = build(null, 3, null)
const B = build(null, 3, (c) => c.includes(1))
const C = build(null, 3, (c) => !c.includes(1))
for (const [nm, rows] of [['制限なし（上位3点）', A], ['1号艇を必ず入れる', B], ['1号艇を必ず外す', C]]) {
  const t = stat(rows)
  console.log(`  ${nm.padEnd(24)} ${String(t.n).padStart(7)}  ${(t.hit * 100).toFixed(1).padStart(5)}%  ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(t.pl >= 0 ? '+' : '') + t.pl.toFixed(0).padStart(5)}円`)
}

// ---------- 3. 「1号艇が飛ぶ」と読んだレースだけ ----------
console.log('\n=== モデルが「1号艇は3着以内に来にくい」と見たレースだけを買う ===')
console.log('  1号艇3連対率の読み  レース数  実際に1号艇が飛んだ率  1号艇外し3点の回収率  前半    後半')
for (const th of [0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
  const sub = races.filter((r) => r.p1in < th)
  if (sub.length < 200) continue
  const ids = new Set(sub.map((r) => r.rid))
  const rows = C.filter((r) => ids.has(r.rid))
  const t = stat(rows); if (!t) continue
  const e = stat(rows.filter(isE)), l = stat(rows.filter((r) => !isE(r)))
  const flew = sub.filter((r) => !r.won1).length / sub.length
  console.log(`  ${(th * 100).toFixed(0)}%未満          ${String(sub.length).padStart(7)}       ${(flew * 100).toFixed(1).padStart(5)}%            ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(e ? (e.roi * 100).toFixed(1) : '-').padStart(6)}%  ${(l ? (l.roi * 100).toFixed(1) : '-').padStart(6)}%`)
}

// ---------- 4. 点数を変える ----------
console.log('\n=== 1号艇を外す買い方・点数別（1号艇3連対率80%未満のレース） ===')
console.log('  点数   レース数  的中率   回収率   1本収支   前半     後半')
const target = new Set(races.filter((r) => r.p1in < 0.8).map((r) => r.rid))
for (const n of [1, 2, 3, 4, 5, 6]) {
  const rows = build(null, n, (c) => !c.includes(1)).filter((r) => target.has(r.rid))
  const t = stat(rows); if (!t) continue
  const e = stat(rows.filter(isE)), l = stat(rows.filter((r) => !isE(r)))
  console.log(`  ${String(n).padStart(2)}点  ${String(t.n).padStart(8)}  ${(t.hit * 100).toFixed(1).padStart(5)}%  ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(t.pl >= 0 ? '+' : '') + t.pl.toFixed(0).padStart(5)}円  ${(e ? (e.roi * 100).toFixed(1) : '-').padStart(6)}%  ${(l ? (l.roi * 100).toFixed(1) : '-').padStart(6)}%`)
}
console.log('\n※ 前半・後半の両方で100%を超えなければ採用しない')
db.close()
