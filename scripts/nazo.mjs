// 「モデルは自信過剰なのに回収が理屈を上回る」の謎を解く。
//   node --max-old-space-size=6144 scripts/nazo.mjs
//
// ★仮説
//   余裕は「下限」であって平均ではない。
//   余裕1.3で選んだ買い目のなかには、p×オッズが1.3ちょうどのものもあれば2.0のものもある。
//   理屈上の回収率は m ではなく **選ばれた買い目の p×オッズ の平均**。
//   それが148%より高ければ、「自信過剰のせいで理屈より下がった」で辻褄が合う。
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
  rs.push({ p: bs[0].p, od, hit: bs[0].y === 1, mo: bs[0].month })
}
console.log(`${rs.length.toLocaleString()}レース\n`)
console.log('余裕ごとに、理屈と実測を分解する')
console.log('  余裕  買う数  p×オッズの平均  理屈上の回収  実際の回収   差   モデルが言った確率  実際の的中率')
for (const m of [1.0, 1.2, 1.3, 1.5, 1.8, 2.2]) {
  const s = rs.filter((r) => r.od >= (1 / r.p) * m)
  if (s.length < 200) continue
  const theo = s.reduce((a, r) => a + r.p * r.od, 0) / s.length * 100
  const h = s.filter((r) => r.hit)
  const act = h.reduce((a, r) => a + r.od * 100, 0) / (s.length * 100) * 100
  const mp = s.reduce((a, r) => a + r.p, 0) / s.length * 100
  const hr = h.length / s.length * 100
  console.log(`  ${m.toFixed(1)} ${String(s.length).padStart(7)} ${theo.toFixed(2).padStart(14)}% ${theo.toFixed(2).padStart(13)}% ${act.toFixed(2).padStart(11)}% ${(act - theo).toFixed(2).padStart(7)} ${mp.toFixed(2).padStart(16)}% ${hr.toFixed(2).padStart(11)}%`)
}
console.log('\n余裕1.3の買い目で、p×オッズがどう散らばっているか')
{
  const s = rs.filter((r) => r.od >= (1 / r.p) * 1.3)
  const v = s.map((r) => r.p * r.od).sort((a, b) => a - b)
  const q = (x) => v[Math.floor(v.length * x)]
  console.log(`  最小 ${v[0].toFixed(2)}　下位25% ${q(0.25).toFixed(2)}　中央 ${q(0.5).toFixed(2)}　上位25% ${q(0.75).toFixed(2)}　上位10% ${q(0.9).toFixed(2)}　平均 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}`)
  console.log('  → 余裕1.3は「下限」で、実際に選ばれた買い目の平均はもっと高い')
}
console.log('\n自信過剰を直したら回収はどうなるか')
{
  // 全レースの確率帯ごとに、実際の的中率へ引き直す（校正）
  const B = []
  for (let i = 0; i < 20; i++) B.push([i * 0.05, (i + 1) * 0.05])
  const cal = new Map()
  for (const [lo, hi] of B) {
    const t = rs.filter((r) => r.p >= lo && r.p < hi)
    if (t.length < 200) continue
    cal.set(lo.toFixed(2), t.filter((r) => r.hit).length / t.length)
  }
  const fix = (p) => { const k = (Math.floor(p / 0.05) * 0.05).toFixed(2); return cal.has(k) ? cal.get(k) : p }
  console.log('  余裕  直す前の買う数  直した後   理屈上   実際の回収')
  for (const m of [1.0, 1.3, 1.5, 1.8]) {
    const a = rs.filter((r) => r.od >= (1 / r.p) * m)
    const b = rs.filter((r) => r.od >= (1 / fix(r.p)) * m)
    if (b.length < 200) continue
    const theo = b.reduce((x, r) => x + fix(r.p) * r.od, 0) / b.length * 100
    const h = b.filter((r) => r.hit)
    const act = h.reduce((x, r) => x + r.od * 100, 0) / (b.length * 100) * 100
    console.log(`  ${m.toFixed(1)} ${String(a.length).padStart(13)} ${String(b.length).padStart(9)} ${theo.toFixed(2).padStart(9)}% ${act.toFixed(2).padStart(11)}%`)
  }
}
db.close()
