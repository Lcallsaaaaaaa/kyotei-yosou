// 配信用：当てることを優先した3連単・3連複の絞り方。
//   node --max-old-space-size=8192 scripts/ent.mjs
//
// ★方針
//   回収率は狙わない（3連単はどう工夫しても83%が天井と分かっている）。
//   「当たる予想」として見せるために、的中率を最大にする絞り方を探す。
//   モデルと市場の上位3点が完全に重なるレースは的中が上がる（実測32.05%／3点）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const MO = new Map()
for (const r of db.prepare(`SELECT DISTINCT race_id, month FROM wi1`).iterate()) MO.set(r.race_id, r.month)
const MP = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = MP.get(r.race_id); if (!a) { a = new Map(); MP.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120) {
      const w = WIN.get(cur), mp = MP.get(cur)
      if (w && w[1] && w[2] && w[3] && mp) {
        let s = 0
        for (const x of list) s += 1 / x.odds
        const q = new Map(list.map((x) => [x.combo, (1 / x.odds) / s]))
        races.push({ rid: cur, mo: MO.get(cur),
          t3: `${w[1]}-${w[2]}-${w[3]}`, tf: [w[1], w[2], w[3]].sort().join('-'),
          m: [...mp].sort((a, b) => b[1] - a[1]), q: [...q].sort((a, b) => b[1] - a[1]),
          od: new Map(list.map((x) => [x.combo, x.odds])) })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, odds FROM odds3t WHERE odds IS NOT NULL ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
const N = races.length
console.log(`${N.toLocaleString()}レース\n`)
const overlap = (r, k) => {
  const a = new Set(r.m.slice(0, k).map((x) => x[0]))
  return r.q.slice(0, k).filter((x) => a.has(x[0])).length
}
const ev = (arr, pts) => {
  let bets = 0, hit = 0, ret = 0
  const per = new Map()
  for (const r of arr) {
    for (const [c] of r.m.slice(0, pts)) {
      bets++
      let a = per.get(r.mo); if (!a) { a = { b: 0, h: 0, r: 0 }; per.set(r.mo, a) }
      a.b++
      if (c === r.t3) { hit++; const o = r.od.get(c) ?? 0; ret += o * 100; a.r += o * 100; a.h++ }
    }
  }
  if (!bets) return null
  const ms = [...per.values()].filter((a) => a.b >= 50)
  const hrs = ms.map((a) => a.h / (a.b / pts) * 100)
  return { n: arr.length, perDay: arr.length / (N / 149.6), hr: hit / arr.length * 100,
    roi: ret / (bets * 100) * 100, avg: hit ? ret / hit : 0,
    hrMin: hrs.length ? Math.min(...hrs) : 0, hrMax: hrs.length ? Math.max(...hrs) : 0 }
}
console.log('■ モデルと市場の上位3点が完全一致するレース（3連単）')
const full3 = races.filter((r) => overlap(r, 3) === 3)
console.log(`  対象 ${full3.length.toLocaleString()}レース（全体の${(full3.length / N * 100).toFixed(1)}%・1日${(full3.length / (N / 149.6)).toFixed(1)}本）\n`)
console.log('  点数  的中率   平均払戻   回収率  月ごとの的中率')
for (const pts of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
  const x = ev(full3, pts)
  console.log(`  ${String(pts).padStart(3)}点 ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(8)}円 ${x.roi.toFixed(2).padStart(7)}% ${x.hrMin.toFixed(1)}〜${x.hrMax.toFixed(1)}%`)
}
console.log('\n■ さらに絞る（上位5点が4点以上重なる）')
const tight = races.filter((r) => overlap(r, 5) >= 4)
console.log(`  対象 ${tight.length.toLocaleString()}レース（1日${(tight.length / (N / 149.6)).toFixed(1)}本）`)
console.log('  点数  的中率   平均払戻   回収率  月ごとの的中率')
for (const pts of [3, 4, 5, 6, 8]) {
  const x = ev(tight, pts)
  if (x) console.log(`  ${String(pts).padStart(3)}点 ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(8)}円 ${x.roi.toFixed(2).padStart(7)}% ${x.hrMin.toFixed(1)}〜${x.hrMax.toFixed(1)}%`)
}
console.log('\n■ 3連複（順序を問わない）でも同じ絞りを試す')
const evF = (arr, pts) => {
  const PAY = new Map()
  for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku' AND amount IS NOT NULL`).iterate())
    PAY.set(r.race_id + '|' + r.combo, r.amount)
  let bets = 0, hit = 0, ret = 0
  for (const r of arr) {
    const f = new Map()
    for (const [c, p] of r.m) { const k = c.split('-').sort().join('-'); f.set(k, (f.get(k) ?? 0) + p) }
    for (const [c] of [...f].sort((a, b) => b[1] - a[1]).slice(0, pts)) {
      bets++
      if (c === r.tf) { hit++; ret += PAY.get(r.rid + '|' + c) ?? 0 }
    }
  }
  return { hr: hit / arr.length * 100, roi: ret / (bets * 100) * 100, avg: hit ? ret / hit : 0 }
}
console.log('  点数  的中率   平均払戻   回収率')
for (const pts of [2, 3, 4, 5, 6]) {
  const x = evF(full3, pts)
  console.log(`  ${String(pts).padStart(3)}点 ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(8)}円 ${x.roi.toFixed(2).padStart(7)}%`)
}
db.close()
