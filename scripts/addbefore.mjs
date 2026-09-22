// 直前情報（展示タイム・チルト・部品交換・調整重量・気温水温）を feat に足す。
//
//   node scripts/addbefore.mjs
//
// ★これは締切前に分かる情報
//   展示航走はレースの15〜20分前に行われ、結果は締切前に公表される。
//   進入コースと違い、買う時点で確実に手に入るので使ってよい。
//
// ★生の展示タイムより「レース内での位置」が効くはず
//   展示タイムは水面・気象・その日のコンディションで全体が上下する。
//   6.70秒が速いかどうかは、同じレースの他5艇と比べないと分からない。
//   だから順位と偏差（レース平均との差）も作る。
//
// ★部品交換は「何を替えたか」より「替えたかどうか」から見る
//   充足率が7,170/160,392（4.5%）しかない。交換したレースだけ記録されるため。
//   NULLは「交換なし」を意味するので、0として扱う。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const COLS = [
  'bf_ex_time',    // 展示タイム（秒）
  'bf_ex_rank',    // レース内の展示タイム順位（1が最速）
  'bf_ex_dev',     // レース平均との差（マイナスが速い）
  'bf_tilt',       // チルト角
  'bf_parts',      // 部品交換したか（0/1）
  'bf_weight',     // 直前計量の体重
  'bf_wadj',       // 番組表の体重との差（調整）
  'bf_air',        // 気温
  'bf_water',      // 水温
]
const existing = new Set(all(`PRAGMA table_info(feat)`).map((c) => c.name))
for (const c of COLS) if (!existing.has(c)) db.exec(`ALTER TABLE feat ADD COLUMN "${c}" REAL`)
console.log(`feat に ${COLS.filter((c) => !existing.has(c)).length} 列を追加（既存 ${COLS.filter((c) => existing.has(c)).length} 列）`)

const rows = all(`
  SELECT b.race_id, b.lane, b.ex_time, b.tilt, b.parts, b.weight,
         p.weight AS pweight, r.air_temp, r.water_temp
  FROM before_info b
  JOIN before_race r ON r.race_id = b.race_id AND r.status = 'ok'
  LEFT JOIN programs p ON p.race_id = b.race_id AND p.lane = b.lane
  ORDER BY b.race_id, b.lane`)
console.log(`直前情報 ${rows.length.toLocaleString()} 行`)

// レース単位にまとめて、展示タイムの順位と偏差を出す
const byRace = new Map()
for (const r of rows) { let g = byRace.get(r.race_id); if (!g) { g = []; byRace.set(r.race_id, g) } g.push(r) }
console.log(`${byRace.size.toLocaleString()} レース`)

const upd = db.prepare(`UPDATE feat SET
  ${COLS.map((c) => `"${c}"=?`).join(', ')}
  WHERE race_id=? AND lane=?`)

let n = 0, skipped = 0
db.exec('BEGIN')
for (const [rid, g] of byRace) {
  const valid = g.filter((x) => x.ex_time != null && x.ex_time > 0)
  const mean = valid.length ? valid.reduce((a, x) => a + x.ex_time, 0) / valid.length : null
  // 展示が速い順に順位を付ける（タイムが小さいほど速い）
  const sorted = [...valid].sort((a, b) => a.ex_time - b.ex_time)
  const rank = new Map(sorted.map((x, i) => [x.lane, i + 1]))
  for (const x of g) {
    const r = upd.run(
      x.ex_time && x.ex_time > 0 ? x.ex_time : null,   // 0は欠測。そのまま入れると偏差が−6.7になる
      rank.get(x.lane) ?? null,
      x.ex_time && x.ex_time > 0 && mean != null ? x.ex_time - mean : null,
      x.tilt ?? null,
      x.parts ? 1 : 0,
      x.weight ?? null,
      x.weight != null && x.pweight != null ? x.weight - x.pweight : null,
      x.air_temp ?? null,
      x.water_temp ?? null,
      rid, x.lane)
    if (r.changes) n++; else skipped++
  }
  if (n % 50000 === 0 && n) { db.exec('COMMIT'); db.exec('BEGIN') }
}
db.exec('COMMIT')
db.exec('ANALYZE feat')
console.log(`更新 ${n.toLocaleString()} 行 / featに無くて飛ばした ${skipped.toLocaleString()} 行`)

console.log('\n=== 検算 ===')
for (const c of COLS) {
  const r = one(`SELECT COUNT("${c}") f, COUNT(*) t, ROUND(AVG("${c}"),3) a, MIN("${c}") mn, MAX("${c}") mx FROM feat`)
  console.log(`  ${c.padEnd(12)} 充足 ${String(r.f).padStart(7)}/${r.t}  平均${String(r.a).padStart(8)}  範囲 ${r.mn} 〜 ${r.mx}`)
}
// 展示順位が1〜6に収まっているか、各レースで1位が1艇だけか
const bad = one(`SELECT COUNT(*) c FROM (SELECT race_id, SUM(bf_ex_rank=1) s FROM feat WHERE bf_ex_rank IS NOT NULL GROUP BY race_id HAVING s <> 1)`)
console.log(`  展示1位が1艇でないレース: ${bad.c}（0であるべき）`)
db.close()
