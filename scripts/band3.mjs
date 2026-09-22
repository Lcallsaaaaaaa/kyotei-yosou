// 3連単の確定オッズで、当たり目がどの帯に集まっているか。
//   node --max-old-space-size=8192 scripts/band3.mjs
//
// ★問い
//   「全体の70%を占めるオッズ帯はどこか」
//   当たった目の確定オッズを集めて、下から70%がどこまでかを出す。
//   同時に「その帯を全部買うと1レース何点になるか」も出す。買えるかどうかはそこで決まる。
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
// レースごとに、当たり目のオッズと「その帯の点数」を数える
const hits = []
const bandCount = new Map()   // しきい値 -> そのオッズ以下の点数の合計
const TH = [5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000, 2000, 5000, 1e9]
for (const t of TH) bandCount.set(t, 0)
let nRace = 0
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120) {
      const w = WIN.get(cur)
      if (w && w[1] && w[2] && w[3]) {
        nRace++
        const truth = `${w[1]}-${w[2]}-${w[3]}`
        const hit = list.find((x) => x.combo === truth)
        if (hit) hits.push(hit.odds)
        for (const t of TH) bandCount.set(t, bandCount.get(t) + list.filter((x) => x.odds <= t).length)
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
hits.sort((a, b) => a - b)
const N = hits.length
console.log(`${nRace.toLocaleString()}レース　当たり目のオッズ ${N.toLocaleString()}件\n`)
const q = (x) => hits[Math.floor(N * x)]
console.log('当たり目の確定オッズの分布')
console.log(`  最小 ${hits[0]}倍　下位10% ${q(0.1)}倍　下位25% ${q(0.25)}倍　中央 ${q(0.5)}倍　上位25% ${q(0.75)}倍　上位10% ${q(0.9)}倍　最大 ${hits[N - 1]}倍`)
console.log('')
for (const p of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
  const th = q(p)
  console.log(`  当たり目の${(p * 100).toFixed(0)}%は ${th}倍以下`)
}
console.log('\nしきい値ごと：その帯を全部買ったらどうなるか')
console.log('  しきい値   当たりのうち何%  1レースの点数  買う金額  的中率  回収率')
for (const t of TH) {
  if (t > 1e8) continue
  const cover = hits.filter((x) => x <= t).length / N * 100
  const pts = bandCount.get(t) / nRace
  if (pts < 0.5) continue
  // その帯を全部買ったときの回収：当たった目のオッズ合計 ÷ 使った金額
  const ret = hits.filter((x) => x <= t).reduce((a, b) => a + b * 100, 0)
  const cost = nRace * pts * 100
  console.log(`  ${String(t).padStart(6)}倍以下 ${cover.toFixed(2).padStart(12)}% ${pts.toFixed(1).padStart(12)}点 ${(pts * 100).toFixed(0).padStart(8)}円 ${cover.toFixed(2).padStart(7)}% ${(ret / cost * 100).toFixed(2).padStart(7)}%`)
}
db.close()
