// 3連単・3連複を実オッズで判定する。モデルは変えない。
//   node --max-old-space-size=8192 scripts/ev3real.mjs
//
// 判定：必要倍率 =(1÷モデルの確率)×余裕　オッズがそれ以上の買い目だけ買う
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const KIND = flag('kind', 'sanrentan')
const TBL = KIND === 'sanrentan' ? 'odds3t' : 'odds3f'

const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const MO = new Map()
for (const r of db.prepare(`SELECT DISTINCT race_id, month FROM wi1`).iterate()) MO.set(r.race_id, r.month)
// モデルの3連単確率
const P = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = P.get(r.race_id); if (!a) { a = new Map(); P.set(r.race_id, a) }
  const k = KIND === 'sanrenpuku' ? r.combo.split('-').sort().join('-') : r.combo
  a.set(k, (a.get(k) ?? 0) + r.p)
}
console.log(`モデルの予想 ${P.size.toLocaleString()}レース`)
// オッズ
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length) {
      const p = P.get(cur), w = WIN.get(cur)
      if (p && w && w[1] && w[2] && w[3]) {
        const truth = KIND === 'sanrenpuku' ? [w[1], w[2], w[3]].sort().join('-') : `${w[1]}-${w[2]}-${w[3]}`
        races.push({ rid: cur, mo: MO.get(cur), truth,
          list: list.map((x) => ({ c: x.combo, o: x.odds, p: p.get(x.combo) ?? 0 })).filter((x) => x.p > 0) })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, odds FROM ${TBL} WHERE odds IS NOT NULL ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
const N = races.length
console.log(`オッズと予想が両方そろう ${N.toLocaleString()}レース（${KIND}）\n`)
const run = (margin, maxPts) => {
  let nR = 0, bets = 0, hit = 0, ret = 0
  for (const r of races) {
    const pick = r.list.filter((x) => x.o >= (1 / x.p) * margin).sort((a, b) => b.p - a.p).slice(0, maxPts)
    if (!pick.length) continue
    nR++
    for (const x of pick) { bets++; if (x.c === r.truth) { hit++; ret += x.o * 100 } }
  }
  if (bets < 200) return null
  return { nR, bets, bpr: bets / nR, hr: hit / nR * 100, roi: ret / (bets * 100) * 100,
    avg: hit ? ret / hit : 0, pl: (ret - bets * 100) / nR, hit }
}
console.log('  余裕  最大点数  買うレース 1R点数  的中率  平均払戻   回収率  1レース損益')
for (const m of [1.0, 1.2, 1.5, 2.0, 3.0, 5.0]) {
  for (const pts of [1, 3, 6, 12]) {
    const x = run(m, pts)
    if (!x) continue
    console.log(`  ${m.toFixed(1)}  ${String(pts).padStart(6)}点 ${String(x.nR).padStart(9)} ${x.bpr.toFixed(1).padStart(6)} ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(8)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.pl.toFixed(0).padStart(10)}円`)
  }
}
console.log('\n最良の設定を月ごとに')
let best = null
for (const m of [1.0, 1.2, 1.5, 2.0, 3.0, 5.0]) for (const pts of [1, 3, 6, 12]) {
  const x = run(m, pts); if (x && x.bets > 3000 && (!best || x.roi > best.x.roi)) best = { m, pts, x }
}
if (best) {
  console.log(`  余裕${best.m} 最大${best.pts}点　全体 回収${best.x.roi.toFixed(2)}%　${best.x.bets.toLocaleString()}点`)
  for (const mo of [...new Set(races.map((r) => r.mo))].filter(Boolean).sort()) {
    let bets = 0, hit = 0, ret = 0
    for (const r of races.filter((r) => r.mo === mo)) {
      const pick = r.list.filter((x) => x.o >= (1 / x.p) * best.m).sort((a, b) => b.p - a.p).slice(0, best.pts)
      for (const x of pick) { bets++; if (x.c === r.truth) { hit++; ret += x.o * 100 } }
    }
    if (bets < 100) continue
    console.log(`  ${mo} ${String(bets).padStart(6)}点 的中${(hit / bets * 100).toFixed(2).padStart(6)}% 回収${(ret / (bets * 100) * 100).toFixed(2).padStart(7)}%`)
  }
}
db.close()
