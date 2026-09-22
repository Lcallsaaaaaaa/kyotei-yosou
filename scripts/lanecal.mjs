// 艇番ごとに「モデルの1着確率が当たっているか」を測る。
//
//   node --max-old-space-size=8192 scripts/lanecal.mjs
//
// ★なぜ
//   「3〜6号艇の1着判定がかなり弱い」という指摘を確かめる。
//   全体の較正（予測≒実際）が合っていても、艇番ごとに偏っていれば
//   外枠を狙う買い目だけが systematically 外れることになる。
//   全体の平均が合うことと、部分が合うことは別。
//   これは 2026-08-23 に「平均が合うことと閾値判定が当たることは別」で
//   一度やらかしているのと同じ型の誤り。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

const rows = db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()
console.log(`wk1 ${rows.length.toLocaleString()}行（${(rows.length / 6).toLocaleString()}レース）\n`)

// ---------- ① 艇番ごとの較正 ----------
console.log('════ ① 艇番ごと：モデルの1着確率 vs 実際 ════')
console.log(' 艇番      本数     予測平均   実際      差       ずれの向き')
for (let L = 1; L <= 6; L++) {
  const s = rows.filter((r) => r.lane === L)
  const ap = s.reduce((a, r) => a + r.p, 0) / s.length
  const ay = s.reduce((a, r) => a + r.y, 0) / s.length
  const d = (ap - ay) * 100
  console.log(`  ${L}号艇 ${String(s.length).padStart(8)} ${(ap * 100).toFixed(2).padStart(9)}% ${(ay * 100).toFixed(2).padStart(8)}% ${d.toFixed(2).padStart(8)}pt   ${Math.abs(d) < 0.5 ? '合っている' : d > 0 ? '★予測が高すぎる（自信過剰）' : '予測が低すぎる'}`)
}

// ---------- ② 艇番×確率帯 ----------
console.log('\n════ ② 艇番×確率帯：どの帯でずれるか ════')
const BANDS = [[0, .05], [.05, .10], [.10, .20], [.20, .35], [.35, .55], [.55, .75], [.75, 1.01]]
console.log(' 艇番  確率帯        本数    予測    実際     差')
for (let L = 1; L <= 6; L++) {
  const s = rows.filter((r) => r.lane === L)
  for (const [lo, hi] of BANDS) {
    const a = s.filter((r) => r.p >= lo && r.p < hi)
    if (a.length < 300) continue
    const ap = a.reduce((x, r) => x + r.p, 0) / a.length
    const ay = a.reduce((x, r) => x + r.y, 0) / a.length
    const d = (ap - ay) * 100
    console.log(`  ${L}号艇 ${(lo * 100).toFixed(0).padStart(3)}〜${(hi * 100).toFixed(0).padStart(3)}% ${String(a.length).padStart(9)} ${(ap * 100).toFixed(1).padStart(7)}% ${(ay * 100).toFixed(1).padStart(7)}% ${d.toFixed(1).padStart(7)}pt${d > 2 ? '  ★' : ''}`)
  }
}

// ---------- ③ モデルが本命に選んだ艇番ごとの成績 ----------
console.log('\n════ ③ モデルが「最有力」に選んだとき、艇番ごとに当たるか ════')
const byRace = new Map()
for (const r of rows) {
  let a = byRace.get(r.race_id); if (!a) { a = []; byRace.set(r.race_id, a) }
  a.push(r)
}
const fav = []
for (const [, a] of byRace) {
  if (a.length !== 6) continue
  fav.push(a.reduce((m, x) => (x.p > m.p ? x : m)))
}
console.log(' 艇番   本命に選んだ回数   割合    予測平均   実際的中    差')
for (let L = 1; L <= 6; L++) {
  const s = fav.filter((r) => r.lane === L)
  if (!s.length) { console.log(`  ${L}号艇          0回`); continue }
  const ap = s.reduce((a, r) => a + r.p, 0) / s.length
  const ay = s.reduce((a, r) => a + r.y, 0) / s.length
  console.log(`  ${L}号艇 ${String(s.length).padStart(12)}回 ${(s.length / fav.length * 100).toFixed(1).padStart(7)}% ${(ap * 100).toFixed(1).padStart(9)}% ${(ay * 100).toFixed(1).padStart(9)}% ${((ap - ay) * 100).toFixed(1).padStart(7)}pt${(ap - ay) * 100 > 2 ? '  ★自信過剰' : ''}`)
}

// ---------- ④ 実際の1着分布と比べる ----------
console.log('\n════ ④ 実際に1着になった割合（市場でも常識の値）と、モデルの平均予測 ════')
console.log(' 艇番    実際の1着率   モデルの平均予測    差')
for (let L = 1; L <= 6; L++) {
  const s = rows.filter((r) => r.lane === L)
  const ay = s.reduce((a, r) => a + r.y, 0) / s.length
  const ap = s.reduce((a, r) => a + r.p, 0) / s.length
  console.log(`  ${L}号艇 ${(ay * 100).toFixed(2).padStart(11)}% ${(ap * 100).toFixed(2).padStart(15)}% ${((ap - ay) * 100).toFixed(2).padStart(8)}pt`)
}
db.close()
