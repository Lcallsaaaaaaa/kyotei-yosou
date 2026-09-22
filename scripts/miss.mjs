// 外したレースの原因を分解する。
//   node --max-old-space-size=6144 scripts/miss.mjs --t wi1
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wi1')

const M = new Map()
for (const r of db.prepare(`SELECT race_id, kimarite, jcd, deadline, wind_speed, wave, grade
    FROM races WHERE date >= '2025-10-01'`).all()) M.set(r.race_id, r)
const E = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num, course, st, st_flag FROM entries`).iterate()) {
  let a = E.get(r.race_id); if (!a) { a = []; E.set(r.race_id, a) }
  a.push(r)
}
const RF = new Map()
for (const r of db.prepare(`SELECT race_id, lane, exc_race_moved, ex_rank, rc_entry_risk FROM rfeat
    WHERE race_id IN (SELECT DISTINCT race_id FROM ${T})`).iterate())
  RF.set(r.race_id + '|' + r.lane, r)

const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const m = M.get(rid); if (!m) continue
  const e = E.get(rid); if (!e) continue
  const win = e.find((x) => x.rank_num === 1)
  const pick = e.find((x) => x.lane === bs[0].lane)
  if (!win || !pick) continue
  const rank = bs.findIndex((b) => b.y === 1)
  rs.push({ rid, p: bs[0].p, pickLane: bs[0].lane, winLane: win.lane,
    hit: bs[0].y === 1, rank, km: m.kimarite,
    pickCourse: pick.course, pickRank: pick.rank_num, pickSt: pick.st, pickFlag: pick.st_flag,
    winCourse: win.course, moved: RF.get(rid + '|1')?.exc_race_moved ?? null })
}
const N = rs.length
const miss = rs.filter((r) => !r.hit)
console.log(`${N.toLocaleString()}レース中 外れ ${miss.length.toLocaleString()}本（${(miss.length / N * 100).toFixed(2)}%）\n`)

const pct = (n) => (n / miss.length * 100).toFixed(1).padStart(5) + '%'
const bar = (n) => '#'.repeat(Math.round(n / miss.length * 50))

console.log('① 本命の艇は何着だったか');
{
  const c = new Map()
  for (const r of miss) { const k = r.pickRank == null ? '失格・欠場' : r.pickRank + '着'; c.set(k, (c.get(k) ?? 0) + 1) }
  for (const [k, n] of [...c].sort((a, b) => (parseInt(a[0]) || 9) - (parseInt(b[0]) || 9)))
    console.log(`  ${k.padEnd(10)} ${String(n).padStart(6)}本 ${pct(n)}  ${bar(n)}`)
}
console.log('\n② 実際に勝ったのはどの枠か（本命はほぼ1号艇）');
{
  const c = new Map()
  for (const r of miss) c.set(r.winLane, (c.get(r.winLane) ?? 0) + 1)
  for (const [k, n] of [...c].sort((a, b) => a[0] - b[0]))
    console.log(`  ${k}号艇      ${String(n).padStart(6)}本 ${pct(n)}  ${bar(n)}`)
}
console.log('\n③ 決まり手');
{
  const c = new Map()
  for (const r of miss) c.set(r.km ?? '不明', (c.get(r.km ?? '不明') ?? 0) + 1)
  const all = new Map()
  for (const r of rs) all.set(r.km ?? '不明', (all.get(r.km ?? '不明') ?? 0) + 1)
  for (const [k, n] of [...c].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(k).padEnd(10)} ${String(n).padStart(6)}本 ${pct(n)}  そのレース型での外れ率 ${(n / all.get(k) * 100).toFixed(1)}%`)
}
console.log('\n④ 本命の進入コースは枠なりだったか');
{
  const wk = miss.filter((r) => r.pickCourse === r.pickLane).length
  const mv = miss.length - wk
  const wkAll = rs.filter((r) => r.pickCourse === r.pickLane).length
  console.log(`  枠なり     ${String(wk).padStart(6)}本 ${pct(wk)}  （全体では${(wkAll / N * 100).toFixed(1)}%）`)
  console.log(`  動いた     ${String(mv).padStart(6)}本 ${pct(mv)}`)
  const mvAll = N - wkAll
  console.log(`  → 本命の進入が動いたレースの外れ率 ${(mv / mvAll * 100).toFixed(1)}%　枠なりなら ${(wk / wkAll * 100).toFixed(1)}%`)
}
console.log('\n⑤ 本命のスタート');
{
  const f = miss.filter((r) => r.pickFlag && r.pickFlag !== '').length
  const fAll = rs.filter((r) => r.pickFlag && r.pickFlag !== '').length
  console.log(`  F・L持ち   ${String(f).padStart(6)}本 ${pct(f)}  （全体${fAll}本中${(f / Math.max(fAll, 1) * 100).toFixed(1)}%が外れ）`)
  const B = [0.05, 0.10, 0.15, 0.20, 0.30, 9]
  let prev = 0
  for (const b of B) {
    const s = rs.filter((r) => r.pickSt != null && r.pickSt > prev && r.pickSt <= b)
    if (s.length < 300) { prev = b; continue }
    const ms = s.filter((r) => !r.hit).length
    console.log(`  ST ${prev.toFixed(2)}〜${b > 1 ? '　　' : b.toFixed(2)}  ${String(s.length).padStart(6)}本  外れ率 ${(ms / s.length * 100).toFixed(1)}%`)
    prev = b
  }
}
console.log('\n⑥ モデルの確率帯ごとの外れ');
{
  for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
    const s = rs.filter((r) => r.p >= lo && r.p < hi)
    if (s.length < 100) continue
    const ms = s.filter((r) => !r.hit)
    console.log(`  確率${lo}〜${hi}  ${String(s.length).padStart(6)}本  外れ${String(ms.length).padStart(6)}本 ${(ms.length / s.length * 100).toFixed(1).padStart(5)}%  外れ全体の${(ms.length / miss.length * 100).toFixed(1)}%`)
  }
}
db.close()
