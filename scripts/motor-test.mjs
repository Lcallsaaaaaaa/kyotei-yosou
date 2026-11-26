// モーターの調子に、モデルが取りこぼしている分があるかを測る。
//
//   node --max-old-space-size=4096 scripts/motor-test.mjs
//
// ★なぜこの測り方か（2026-10-06）
//   「モーター評価を出せないか」という話だが、モデルはすでにモーターを
//   **6つの項目**で使っている（derive.mjs）：
//     motor（通算）・motor_lane（コース別）・motor_r20_n/p1/p3/ex
//     （その場のそのモーターの直近20走・1着率・3着内率・展示タイム平均）
//   だから「モーターは効くか」を測っても意味が無い。**すでに入っている**。
//
//   measurable な問いはこれ：
//     **モデルの確率を揃えたうえで、モーター2連率の差がまだ着順に効くか。**
//   効くなら、モデルが取りこぼしている＝項目の入れ方を直す余地がある。
//   効かないなら、モーター評価を別に出しても判断の足しにはならない（表示物としては別の話）。
//
// ★材料は pred（学習外の本番予測）だけ使う。
//   予想ファイルから作ると汚れる（[[boatrace-predict-file-rewritten]]）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')
console.log('材料を読み込んでいます…')

// 学習外の1着確率 + 着順
const rows = db.prepare(`SELECT p.race_id, p.lane, p.p, p.y,
    g.motor_top2, g.motor_top3, g.boat_top2
  FROM pred p JOIN programs g ON g.race_id = p.race_id AND g.lane = p.lane
  WHERE p.p IS NOT NULL AND p.y IS NOT NULL AND g.motor_top2 IS NOT NULL`).all()
db.close()

if (!rows.length) { console.log('材料がありません'); process.exit(0) }

// レースごとにまとめ、モーター2連率の順位を出す
const byRace = new Map()
for (const r of rows) {
  if (!byRace.has(r.race_id)) byRace.set(r.race_id, [])
  byRace.get(r.race_id).push(r)
}
const ids = [...byRace.keys()].filter((id) => byRace.get(id).length === 6).sort()
console.log('')
console.log(`■ 学習外 ${ids.length.toLocaleString()}レース（${ids[0].slice(0, 8)}〜${ids.at(-1).slice(0, 8)}）`)
const CUT = ids[Math.floor(ids.length / 2)].slice(0, 8)
const half = (id) => (id.slice(0, 8) < CUT ? 0 : 1)
console.log(`  前半 〜${CUT} ／ 後半 ${CUT}〜`)
console.log('')

// 各艇に「レース内でのモーター2連率の順位」と「レース平均との差」を付ける
const boats = []
for (const id of ids) {
  const bs = byRace.get(id)
  const avg = bs.reduce((s, x) => s + x.motor_top2, 0) / 6
  const order = bs.slice().sort((a, b) => b.motor_top2 - a.motor_top2)
  const rankOf = new Map(order.map((x, i) => [x.lane, i + 1]))
  for (const b of bs) boats.push({ ...b, h: half(id),
    mrank: rankOf.get(b.lane), mdiff: b.motor_top2 - avg })
}

const pc = (a, b) => (b ? (a / b * 100).toFixed(2) : '0.00').padStart(6) + '%'

// ---------- ① モデルの確率を揃えて、モーターの順位で分ける ----------
// 確率が近い艇どうしを比べる。モデルがモーターを使い切っていれば差は出ない。
console.log('【モデルの確率を揃えて、モーター2連率の順位で比べる】')
console.log('  確率の帯ごとに「モーター1位の艇」と「モーター6位の艇」の実際の1着率を並べる')
console.log('')
console.log('  確率の帯      モーター1位（件数・1着率）      モーター6位（件数・1着率）     差（前半/後半）')
const BANDS = [[0, 0.05], [0.05, 0.10], [0.10, 0.20], [0.20, 0.35], [0.35, 0.55], [0.55, 1.01]]
let consistent = 0
for (const [lo, hi] of BANDS) {
  const inBand = boats.filter((b) => b.p >= lo && b.p < hi)
  const cell = (mr, h) => {
    const s = inBand.filter((b) => b.mrank === mr && b.h === h)
    return { n: s.length, w: s.filter((b) => b.y === 1).length }
  }
  const a = [cell(1, 0), cell(1, 1)], z = [cell(6, 0), cell(6, 1)]
  if (a.some((x) => x.n < 200) || z.some((x) => x.n < 200)) {
    console.log(`  ${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}%　本数が足りないので飛ばします`)
    continue
  }
  const d = [0, 1].map((h) => (a[h].w / a[h].n - z[h].w / z[h].n) * 100)
  const same = d[0] * d[1] > 0 && Math.min(Math.abs(d[0]), Math.abs(d[1])) >= 1.0
  if (same) consistent++
  console.log(`  ${(String((lo * 100).toFixed(0)) + '〜' + (hi * 100).toFixed(0) + '%').padEnd(10)}`
    + `${String(a[0].n + a[1].n).padStart(6)}件 ${pc(a[0].w, a[0].n)}/${pc(a[1].w, a[1].n)}   `
    + `${String(z[0].n + z[1].n).padStart(6)}件 ${pc(z[0].w, z[0].n)}/${pc(z[1].w, z[1].n)}   `
    + `${same ? '★' : ' '}${d[0].toFixed(2).padStart(6)}pt/${d[1].toFixed(2).padStart(6)}pt`)
}
console.log('')

// ---------- ② 予測と実際のずれが、モーターの順位で偏るか ----------
// モデルが使い切っていれば、どの順位でもずれは0に近いはず。
console.log('【予測と実際のずれ（実際 − 予測）がモーターの順位で偏るか】')
console.log('  0に近ければモデルが使い切っている。符号がそろって大きければ取りこぼし')
console.log('')
console.log('  モーター順位   件数      予測平均     実際の1着率    ずれ（前半/後半）')
let biased = 0
for (let mr = 1; mr <= 6; mr++) {
  const s = [0, 1].map((h) => boats.filter((b) => b.mrank === mr && b.h === h))
  const row = s.map((x) => ({ n: x.length, p: x.reduce((t, b) => t + b.p, 0) / (x.length || 1),
    w: x.filter((b) => b.y === 1).length / (x.length || 1) }))
  const d = row.map((r) => (r.w - r.p) * 100)
  const same = d[0] * d[1] > 0 && Math.min(Math.abs(d[0]), Math.abs(d[1])) >= 0.5
  if (same) biased++
  console.log(`  ${String(mr).padStart(6)}位    ${String(row[0].n + row[1].n).padStart(7)}件  `
    + `${pc(row[0].p * row[0].n, row[0].n)}      ${pc(row[0].w * row[0].n, row[0].n)}      `
    + `${same ? '★' : ' '}${d[0].toFixed(2).padStart(6)}pt/${d[1].toFixed(2).padStart(6)}pt`)
}
console.log('')

// ---------- まとめ ----------
console.log('■ まとめ')
console.log(`  確率を揃えた比較で前半・後半とも1pt以上の差が出た帯：${consistent}/${BANDS.length}`)
console.log(`  ずれの符号が前半・後半でそろった順位：${biased}/6`)
if (!consistent && !biased) {
  console.log('  → **モデルはモーターを使い切っている。** モーター評価を別に出しても判断の足しにはならない')
  console.log('     （画面に出す表示物としては別の話。teikore が出しているのはこれ）')
} else {
  console.log('  → ★のところに取りこぼしがある。derive.mjs のモーター項目を見直す価値がある')
}
console.log('')
console.log('※ 使ったのは pred（学習外の本番予測）だけ。予想ファイルは使っていない')
