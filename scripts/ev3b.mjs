// 3連単・3連複の回収率を、買い方だけで上げられるか。モデルは変えない。
//   node --max-old-space-size=6144 scripts/ev3b.mjs
//
// ★試す手
//   ① レースを選ぶ … 本命の確率が高い／低いレースだけ買う
//   ② 相手を絞る   … 1着は本命に固定し、2着3着だけ流す（フォーメーション）
//   ③ 配当の下限   … 実際の配当が低くなりそうな買い目を外す（単勝オッズで代用）
//   ④ 点数を減らす … 上位1点だけ
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
    WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1`).iterate()) {
  let a = P1.get(r.race_id); if (!a) { a = []; P1.set(r.race_id, a) }
  a.push(r)
}
for (const [, a] of P1) a.sort((x, y) => y.p - x.p)
const races = []
let cur = null, rows = []
const flush = () => {
  if (!cur) { rows = []; return }
  const t = P1.get(cur), o = OD.get(cur)
  if (t && rows.length === 120) {
    rows.sort((a, b) => b.p - a.p)
    races.push({ rid: cur, p1: t[0].p, lane: t[0].lane, od: o?.[t[0].lane] ?? null, list: rows.map((r) => ({ combo: r.combo, p: r.p })) })
  }
  rows = []
}
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()) {
  if (r.race_id !== cur) { flush(); cur = r.race_id }
  rows.push(r)
}
flush()
const N = races.length
console.log(`${N.toLocaleString()}レース\n`)
const fold = (c) => c.split('-').sort().join('-')
const run = (kind, sel) => {
  let n = 0, bets = 0, hit = 0, ret = 0
  for (const r of races) {
    const pick = sel(r)
    if (!pick || !pick.length) continue
    n++
    const seen = new Set()
    for (const c0 of pick) {
      const c = kind === 'sanrenpuku' ? fold(c0) : c0
      if (seen.has(c)) continue
      seen.add(c); bets++
      const a = PAY.get(r.rid + '|' + kind + '|' + c)
      if (a != null) { hit++; ret += a }
    }
  }
  if (!bets) return null
  return { n, bpr: bets / n, hr: hit / n * 100, roi: ret / (bets * 100) * 100, avg: hit ? ret / hit : 0, pl: (ret - bets * 100) / n }
}
const show = (lab, x) => { if (x && x.n >= 300) console.log(`  ${lab.padEnd(32)} ${String(x.n).padStart(7)}R ${x.bpr.toFixed(1).padStart(5)}点 的中${x.hr.toFixed(2).padStart(6)}% 平均${x.avg.toFixed(0).padStart(6)}円 回収${x.roi.toFixed(2).padStart(7)}% 1R${x.pl.toFixed(0).padStart(6)}円`) }

console.log('■ ① レースを選ぶ（3連単1点）')
for (const [lo, hi] of [[0, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, 0.8], [0.8, 1.01]])
  show(`本命の確率 ${lo}〜${hi}`, run('sanrentan', (r) => (r.p1 >= lo && r.p1 < hi) ? [r.list[0].combo] : null))

console.log('\n■ ② 1着は本命に固定して2・3着を流す（3連単）')
for (const [nm, k2, k3] of [['2着2頭×3着2頭 (4点)', 2, 2], ['2着2頭×3着3頭 (6点)', 2, 3], ['2着3頭×3着3頭 (6点)', 3, 3]]) {
  show(nm, run('sanrentan', (r) => {
    const top = r.lane
    const seq = r.list.filter((x) => x.combo.startsWith(top + '-'))
    const l2 = [...new Set(seq.map((x) => x.combo.split('-')[1]))].slice(0, k2)
    const l3 = [...new Set(seq.map((x) => x.combo.split('-')[2]))].slice(0, k3)
    const out = []
    for (const b of l2) for (const c of l3) if (b !== c && b !== String(top) && c !== String(top)) out.push(`${top}-${b}-${c}`)
    return out
  }))
}
console.log('\n■ ③ 本命の単勝オッズで絞る（3連単1点）')
for (const [lo, hi] of [[1, 1.5], [1.5, 2], [2, 3], [3, 5], [5, 99]])
  show(`本命の単勝 ${lo}〜${hi}倍`, run('sanrentan', (r) => (r.od > lo && r.od <= hi) ? [r.list[0].combo] : null))

console.log('\n■ ④ 3連複でも同じ絞り（1点）')
for (const [lo, hi] of [[0, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, 0.8], [0.8, 1.01]])
  show(`本命の確率 ${lo}〜${hi}`, run('sanrenpuku', (r) => (r.p1 >= lo && r.p1 < hi) ? [r.list[0].combo] : null))
for (const [lo, hi] of [[1, 1.5], [1.5, 2], [2, 3], [3, 5], [5, 99]])
  show(`本命の単勝 ${lo}〜${hi}倍`, run('sanrenpuku', (r) => (r.od > lo && r.od <= hi) ? [r.list[0].combo] : null))
db.close()
