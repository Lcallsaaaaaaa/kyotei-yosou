// 進入コースを予測する。
//
//   node scripts/entry-model.mjs                 選手ごとの進入傾向を推定して保存
//   node scripts/entry-model.mjs --check         予測精度を検証期間で確認
//
// ★なぜ要るか
//   予想時点で分かるのは「枠」だけで、成績は「進入コース」別に持っている。
//   いま `ev.mjs` は「枠＝コース」と決め打ちしているが、実測では
//     枠1 98.8% / 枠4 88.5% / 枠5 84.2% / 枠6 86.6%
//   しか一致しない。**外枠ほど前提が崩れる。**
//   さらに前づけは一部の選手に集中している（西島義則66%・石川真二66%）ので、
//   選手ごとの傾向を持てば予測できる。
//
// ★モデル
//   選手ごとに「枠からどれだけ内へ動くか」の平均と散らばりを推定する。
//   予測時は各艇に「進入したい位置 = 枠 − 傾向 + 雑音」を割り当て、
//   小さい順に1〜6コースを配る。これで必ず正しい順列になる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const all = (s, ...p) => db.prepare(s).all(...p)

const SPLIT = '2026-02-18'
const K_SHIFT = 30 // 前づけ傾向の縮小（小標本を全体平均へ引き寄せる）

// ---------- 学習：選手 × 枠 ごとの「内へ動く量」 ----------
const rows = all(`SELECT e.racer_id, e.lane, e.course, COUNT(*) n
  FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND e.racer_id IS NOT NULL AND r.date < ?
  GROUP BY e.racer_id, e.lane, e.course`, SPLIT)

// 全体平均（枠ごとの平均シフト量）＝縮小の寄せ先
const laneBase = {}
{
  const acc = {}
  for (const r of rows) {
    acc[r.lane] ??= { sum: 0, n: 0 }
    acc[r.lane].sum += (r.lane - r.course) * r.n
    acc[r.lane].n += r.n
  }
  for (const l of Object.keys(acc)) laneBase[l] = acc[l].sum / acc[l].n
}

const racer = new Map() // `${racer_id}:${lane}` -> { n, shift }
{
  const acc = new Map()
  for (const r of rows) {
    const k = `${r.racer_id}:${r.lane}`
    if (!acc.has(k)) acc.set(k, { sum: 0, n: 0 })
    const a = acc.get(k)
    a.sum += (r.lane - r.course) * r.n
    a.n += r.n
  }
  for (const [k, a] of acc) {
    const lane = Number(k.split(':')[1])
    const prior = laneBase[lane] ?? 0
    racer.set(k, { n: a.n, shift: (a.sum + K_SHIFT * prior) / (a.n + K_SHIFT) })
  }
}

console.log('=== 枠ごとの平均シフト量（正なら内へ動く）===')
for (let l = 1; l <= 6; l++) console.log(`  枠${l}  ${laneBase[l].toFixed(3)} コース`)

if (!process.argv.includes('--check')) {
  const out = { K_SHIFT, laneBase, racer: Object.fromEntries([...racer].map(([k, v]) => [k, Number(v.shift.toFixed(4))])) }
  writeFileSync(join(ROOT, 'data', 'entry-model.json'), JSON.stringify(out))
  console.log(`\n保存: data/entry-model.json （選手×枠 ${racer.size} 件）`)
  db.close()
  process.exit(0)
}

// ---------- 検証：予測した進入と実際の進入を比べる ----------
const test = all(`SELECT e.race_id, e.lane, e.course, e.racer_id
  FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course IS NOT NULL AND r.date >= ? ORDER BY e.race_id, e.lane`, SPLIT)
const byRace = new Map()
for (const r of test) {
  if (!byRace.has(r.race_id)) byRace.set(r.race_id, [])
  byRace.get(r.race_id).push(r)
}

const shiftOf = (id, lane) => racer.get(`${id}:${lane}`)?.shift ?? laneBase[lane] ?? 0

let nRace = 0, hitWaku = 0, hitPred = 0, exactWaku = 0, exactPred = 0
for (const [, bs] of byRace) {
  if (bs.length !== 6) continue
  nRace++
  // 予測：枠 − 傾向 の小さい順に1〜6を配る
  const scored = bs.map((b) => ({ lane: b.lane, course: b.course, pos: b.lane - shiftOf(b.racer_id, b.lane) }))
  const pred = scored.slice().sort((a, b) => a.pos - b.pos || a.lane - b.lane)
  pred.forEach((p, i) => { p.predCourse = i + 1 })

  for (const p of pred) {
    if (p.lane === p.course) hitWaku++
    if (p.predCourse === p.course) hitPred++
  }
  if (pred.every((p) => p.lane === p.course)) exactWaku++
  if (pred.every((p) => p.predCourse === p.course)) exactPred++
}
const n6 = nRace * 6
console.log(`\n=== 検証（${SPLIT}〜  ${nRace.toLocaleString()}レース）===`)
console.log(`艇単位の進入的中率`)
console.log(`  枠なり決め打ち（現行）  ${((hitWaku / n6) * 100).toFixed(2)}%`)
console.log(`  進入予測モデル          ${((hitPred / n6) * 100).toFixed(2)}%   ${hitPred > hitWaku ? '★改善 +' + (((hitPred - hitWaku) / n6) * 100).toFixed(2) + 'pt' : '（改善せず）'}`)
console.log(`レース単位（6艇すべて的中）`)
console.log(`  枠なり決め打ち          ${((exactWaku / nRace) * 100).toFixed(2)}%`)
console.log(`  進入予測モデル          ${((exactPred / nRace) * 100).toFixed(2)}%   ${exactPred > exactWaku ? '★改善 +' + (((exactPred - exactWaku) / nRace) * 100).toFixed(2) + 'pt' : '（改善せず）'}`)

// 枠別の内訳
console.log(`\n枠別の的中率`)
console.log('枠    枠なり決め打ち   進入予測モデル')
const perLane = {}
for (const [, bs] of byRace) {
  if (bs.length !== 6) continue
  const scored = bs.map((b) => ({ lane: b.lane, course: b.course, racer_id: b.racer_id, pos: b.lane - shiftOf(b.racer_id, b.lane) }))
  const pred = scored.slice().sort((a, b) => a.pos - b.pos || a.lane - b.lane)
  pred.forEach((p, i) => { p.predCourse = i + 1 })
  for (const p of pred) {
    perLane[p.lane] ??= { n: 0, w: 0, m: 0 }
    perLane[p.lane].n++
    if (p.lane === p.course) perLane[p.lane].w++
    if (p.predCourse === p.course) perLane[p.lane].m++
  }
}
for (let l = 1; l <= 6; l++) {
  const a = perLane[l]
  const w = (a.w / a.n) * 100, m = (a.m / a.n) * 100
  console.log(` ${l}      ${w.toFixed(2)}%          ${m.toFixed(2)}%   ${m > w ? '+' + (m - w).toFixed(2) + 'pt' : (m - w).toFixed(2) + 'pt'}`)
}
db.close()
