// 「固いレース」を事前に見分けて、そこだけ買ったらどうなるか。
//   node --max-old-space-size=8192 scripts/katai.mjs
//
// ★問いの言い換え
//   「当たり目が50倍以下だったレース」は結果を見ないと分からない。
//   事前に見えるのは**市場のオッズの集中度**。本命の3連単オッズが低いほど票が集中している。
//   それで固いレースを選び、そこだけ買ったらどうなるかを測る。
//
// ★あわせて
//   実際に当たり目が50倍以下だったレースが、事前にどんな顔をしているかも出す。
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
const P3 = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = P3.get(r.race_id); if (!a) { a = new Map(); P3.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1`).iterate()) {
  let a = P1.get(r.race_id); if (!a) { a = []; P1.set(r.race_id, a) }
  a.push(r)
}
for (const [, a] of P1) a.sort((x, y) => y.p - x.p)
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120) {
      const w = WIN.get(cur), mp = P3.get(cur), t1 = P1.get(cur)
      if (w && w[1] && w[2] && w[3] && mp && t1) {
        const truth = `${w[1]}-${w[2]}-${w[3]}`
        const byOdds = list.slice().sort((a, b) => a.odds - b.odds)
        const model = list.map((x) => ({ c: x.combo, o: x.odds, p: mp.get(x.combo) ?? 0 }))
          .sort((a, b) => b.p - a.p)
        const hit = list.find((x) => x.combo === truth)
        races.push({ rid: cur, mo: MO.get(cur), truth,
          favOdds: byOdds[0].odds,                      // 市場の本命の3連単オッズ
          n50: list.filter((x) => x.odds <= 50).length, // 50倍以下の点数（集中度）
          p1: t1[0].p, model, hitOdds: hit ? hit.odds : null })
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

console.log('■ 当たり目が50倍以下だったレースは、事前にどんな顔をしているか')
{
  const lo = races.filter((r) => r.hitOdds != null && r.hitOdds <= 50)
  const hi = races.filter((r) => r.hitOdds != null && r.hitOdds > 50)
  const avg = (a, f) => a.reduce((x, r) => x + f(r), 0) / a.length
  console.log(`  50倍以下で決着 ${lo.length.toLocaleString()}本（${(lo.length / N * 100).toFixed(1)}%）／それ以外 ${hi.length.toLocaleString()}本`)
  console.log(`  市場の本命オッズ    50倍以下決着 ${avg(lo, (r) => r.favOdds).toFixed(1)}倍　それ以外 ${avg(hi, (r) => r.favOdds).toFixed(1)}倍`)
  console.log(`  50倍以下の点数      50倍以下決着 ${avg(lo, (r) => r.n50).toFixed(1)}点　それ以外 ${avg(hi, (r) => r.n50).toFixed(1)}点`)
  console.log(`  モデルの本命確率    50倍以下決着 ${avg(lo, (r) => r.p1).toFixed(3)}　それ以外 ${avg(hi, (r) => r.p1).toFixed(3)}`)
}
console.log('\n■ 事前に見える「市場の本命オッズ」で選ぶ（モデルの確率順に買う）')
console.log('  本命オッズ帯   レース数   1日   50倍以下決着  1点的中  1点回収  3点的中  3点回収')
const ev = (arr, pts) => {
  let hit = 0, ret = 0
  for (const r of arr) for (const x of r.model.slice(0, pts)) if (x.c === r.truth) { hit++; ret += x.o * 100 }
  return { hr: hit / arr.length * 100, roi: ret / (arr.length * pts * 100) * 100 }
}
for (const [lo, hi] of [[0, 5], [5, 8], [8, 12], [12, 20], [20, 35], [35, 1e9]]) {
  const s = races.filter((r) => r.favOdds > lo && r.favOdds <= hi)
  if (s.length < 500) continue
  const a = ev(s, 1), b = ev(s, 3)
  const lowRate = s.filter((r) => r.hitOdds != null && r.hitOdds <= 50).length / s.length * 100
  const lab = hi > 1e8 ? `${lo}倍超` : `${lo}〜${hi}倍`
  console.log(`  ${lab.padEnd(12)} ${String(s.length).padStart(8)} ${(s.length / 303).toFixed(1).padStart(5)}本 ${lowRate.toFixed(1).padStart(11)}% ${a.hr.toFixed(2).padStart(8)}% ${a.roi.toFixed(2).padStart(8)}% ${b.hr.toFixed(2).padStart(7)}% ${b.roi.toFixed(2).padStart(8)}%`)
}
console.log('\n■ 「50倍以下の点数」で選ぶ（少ないほど票が集中＝固い）')
console.log('  50倍以下の点数  レース数   1日   1点的中  1点回収  3点的中  3点回収')
for (const [lo, hi] of [[0, 8], [8, 12], [12, 16], [16, 22], [22, 30], [30, 999]]) {
  const s = races.filter((r) => r.n50 > lo && r.n50 <= hi)
  if (s.length < 500) continue
  const a = ev(s, 1), b = ev(s, 3)
  console.log(`  ${String(lo).padStart(3)}〜${String(hi).padStart(3)}点 ${String(s.length).padStart(12)} ${(s.length / 303).toFixed(1).padStart(5)}本 ${a.hr.toFixed(2).padStart(8)}% ${a.roi.toFixed(2).padStart(8)}% ${b.hr.toFixed(2).padStart(7)}% ${b.roi.toFixed(2).padStart(8)}%`)
}
console.log('\n■ 買う目を「オッズ50倍以下」に限る（モデルの確率順・固いレースだけ）')
console.log('  条件                        レース数  1R点数  的中率   回収率  月ごとプラス')
const MOS = [...new Set(races.map((r) => r.mo))].filter(Boolean).sort()
for (const [nm, f, pts] of [
  ['本命5倍以下', (r) => r.favOdds <= 5, 3],
  ['本命8倍以下', (r) => r.favOdds <= 8, 3],
  ['本命12倍以下', (r) => r.favOdds <= 12, 3],
  ['本命8倍以下', (r) => r.favOdds <= 8, 1],
  ['本命12倍以下', (r) => r.favOdds <= 12, 1],
]) {
  const s = races.filter(f)
  if (s.length < 500) continue
  let bets = 0, hit = 0, ret = 0
  for (const r of s) {
    const pick = r.model.filter((x) => x.o <= 50).slice(0, pts)
    for (const x of pick) { bets++; if (x.c === r.truth) { hit++; ret += x.o * 100 } }
  }
  const plus = MOS.filter((mo) => {
    const t = s.filter((r) => r.mo === mo)
    if (t.length < 50) return false
    let b = 0, rr = 0
    for (const r of t) for (const x of r.model.filter((y) => y.o <= 50).slice(0, pts)) { b++; if (x.c === r.truth) rr += x.o * 100 }
    return b && rr / (b * 100) >= 1
  }).length
  console.log(`  ${nm.padEnd(14)}${String(pts).padStart(2)}点 ${String(s.length).padStart(10)} ${(bets / s.length).toFixed(1).padStart(6)} ${(hit / s.length * 100).toFixed(2).padStart(7)}% ${(ret / (bets * 100) * 100).toFixed(2).padStart(8)}% ${String(plus).padStart(8)}/${MOS.length}ヶ月`)
}
db.close()
