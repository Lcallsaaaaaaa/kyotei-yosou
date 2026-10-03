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

// ★展示の進入コースを足した（2026-10-02）
//   モデルは「その選手の1コースでの成績」〜「6コースでの成績」を全部渡されるが、
//   **どれが当てはまるかを知らない**。進入は締切後にしか確定しないので、
//   学習も予想も枠番で代用していた（predict.mjs:13「進入は枠番で代用」）。
//
//   実測（entries.course と突き合わせ・1,365,654艇）:
//     枠番      → 実際の進入と一致 90.13%（6艇すべて一致は 80.4%）
//     展示の進入 → 一致 94.85%（6艇すべて一致は 88.0%）
//     前づけがあった44,122レースでは、枠番 0.0% に対し展示 51.7%
//
//   そして歩進検証271,592艇で、モデルのズレは「動いた艇」に集中していた:
//     内へ4つ   574艇  予測 9.90% → 実際18.82%  +8.92pt（±1.63）
//     内へ3つ   823艇  予測13.97% → 実際16.77%  +2.80pt（±1.30）
//     枠なり 250,820艇 予測17.26% → 実際17.17%  −0.09pt
//     外へ1つ  9,060艇 予測 8.61% → 実際 9.64%  +1.02pt（±0.31）
//     外へ2つ  1,619艇 予測 7.18% → 実際 9.08%  +1.90pt（±0.71）
//   進入を動かすのは動かせる力のある選手で、その自己選抜を拾えていない。
//
//   exc_* は course{進入}_* をそのまま写したもの。derive.mjs が既に
//   コース別の成績を作っているので、どれを見るかを教えるだけで済む。
//   ⚠ 02:00 には展示が無いので、朝モデルからは NOMORN で除外される
//     （model5.mjs の /^(bf_|waveb_|windb_|nami5_|exc_)/）。
const EXC = ['exc_n', 'exc_p1', 'exc_p2', 'exc_p3', 'exc_sho', 'exc_st', 'exc_ex']
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
  'bf_ex_course',  // 展示での進入コース（1〜6）
  'bf_ex_move',    // 枠番からの移動（マイナスが内へ・プラスが外へ）
  ...EXC,          // その選手の「展示が示すコース」での成績
]
const existing = new Set(all(`PRAGMA table_info(feat)`).map((c) => c.name))
for (const c of COLS) if (!existing.has(c)) db.exec(`ALTER TABLE feat ADD COLUMN "${c}" REAL`)
console.log(`feat に ${COLS.filter((c) => !existing.has(c)).length} 列を追加（既存 ${COLS.filter((c) => existing.has(c)).length} 列）`)

// exc_* は feat の course{N}_* をそのまま写す。元の列名を用意しておく。
const SRC = ['n', 'p1', 'p2', 'p3', 'sho', 'st', 'ex']
const courseCols = [1, 2, 3, 4, 5, 6].map((c) => SRC.map((s) => `course${c}_${s}`))
const rows = all(`
  SELECT b.race_id, b.lane, b.ex_time, b.ex_course, b.tilt, b.parts, b.weight,
         p.weight AS pweight, r.air_temp, r.water_temp,
         ${courseCols.flat().map((c) => `f."${c}"`).join(', ')}
  FROM before_info b
  JOIN before_race r ON r.race_id = b.race_id AND r.status = 'ok'
  LEFT JOIN programs p ON p.race_id = b.race_id AND p.lane = b.lane
  LEFT JOIN feat f ON f.race_id = b.race_id AND f.lane = b.lane
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
      // ★進入は1〜6のときだけ使う。0や範囲外は欠測扱い（入れると別コースの成績を写してしまう）
      x.ex_course >= 1 && x.ex_course <= 6 ? x.ex_course : null,
      x.ex_course >= 1 && x.ex_course <= 6 ? x.ex_course - x.lane : null,
      ...(x.ex_course >= 1 && x.ex_course <= 6
        ? SRC.map((s) => x[`course${x.ex_course}_${s}`] ?? null)
        : SRC.map(() => null)),
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
