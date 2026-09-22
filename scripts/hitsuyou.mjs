// 「モデルの確率から必要倍率を出し、オッズがそれ以上なら買う」を測る。
//   node --max-old-space-size=6144 scripts/hitsuyou.mjs
//
// ★判定の形
//   必要倍率 = (1 ÷ モデルの確率) × 余裕
//   見えているオッズ ≥ 必要倍率 なら買う。余裕1.0なら「損得ゼロの線」。
//
// ★注意：締切間際の値動き
//   本命は締切1分前から確定までに中央7%下がる（実測103レース）。
//   つまり「見えているオッズ」で判定して買っても、受け取りはそれより低い。
//   ここでは①値動きなしと②本命7%下がる の両方を出す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  O.set(r.race_id + '|' + r.lane, r.tansho)
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1 ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const od = O.get(rid + '|' + bs[0].lane)
  if (!(od > 0)) continue
  rs.push({ p: bs[0].p, od, hit: bs[0].y === 1, mo: bs[0].month, lane: bs[0].lane })
}
const N = rs.length
console.log(`${N.toLocaleString()}レース　本命の単勝\n`)
const run = (margin, drift) => {
  const s = rs.filter((r) => r.od >= (1 / r.p) * margin)
  if (!s.length) return null
  const h = s.filter((r) => r.hit)
  const ret = h.reduce((a, r) => a + r.od * drift * 100, 0)
  return { n: s.length, hr: h.length / s.length * 100, roi: ret / (s.length * 100) * 100,
    avg: h.length ? ret / h.length : 0, pl: (ret - s.length * 100) / s.length, s }
}
console.log('  余裕   買う数  1日   平均確率 平均オッズ 的中率  平均払戻   回収率  1レース  値動き込みの回収')
for (const m of [0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.2, 3.0]) {
  const a = run(m, 1), b = run(m, 0.93)
  if (!a || a.n < 100) continue
  console.log(`  ${m.toFixed(1)}  ${String(a.n).padStart(7)} ${(a.n / 303).toFixed(1).padStart(5)}本 ${(a.s.reduce((x, r) => x + r.p, 0) / a.n).toFixed(3).padStart(7)} ${(a.s.reduce((x, r) => x + r.od, 0) / a.n).toFixed(2).padStart(8)} ${a.hr.toFixed(2).padStart(6)}% ${a.avg.toFixed(0).padStart(7)}円 ${a.roi.toFixed(2).padStart(8)}% ${a.pl.toFixed(0).padStart(6)}円 ${b.roi.toFixed(2).padStart(12)}%`)
}
console.log('\n余裕1.3の月ごと（値動きなし／本命7%下がる）')
{
  const a = run(1.3, 1)
  for (const mo of [...new Set(rs.map((r) => r.mo))].sort()) {
    const s = a.s.filter((r) => r.mo === mo)
    if (s.length < 20) continue
    const h = s.filter((r) => r.hit)
    const r1 = h.reduce((x, r) => x + r.od * 100, 0) / (s.length * 100) * 100
    const r2 = h.reduce((x, r) => x + r.od * 0.93 * 100, 0) / (s.length * 100) * 100
    console.log(`  ${mo} ${String(s.length).padStart(4)}本 的中${(h.length / s.length * 100).toFixed(1).padStart(5)}% 回収${r1.toFixed(1).padStart(6)}% / ${r2.toFixed(1).padStart(6)}%`)
  }
}
db.close()
