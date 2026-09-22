// 検証結果の集計をCSVで出す（races.csv と対で使う）。
//
//   node --max-old-space-size=8192 scripts/export-summary.mjs
//
// ★中身
//   ① 艇番ごとの較正（予測 vs 実際）
//   ② 艇番×確率帯の較正
//   ③ 条件ごとの成績（確定オッズで足切り＝実行不能／締切前オッズ＝実運用）
//   ④ 月別
//   すべて races.csv から手で検算できる値にしてある。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { minOddsFor, MARGIN, FUKU } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const out = []
const push = (...a) => out.push(a.join(','))
const pc = (x) => (x * 100).toFixed(2)

// ---------- ① 艇番ごとの較正 ----------
push('■①艇番ごとの1着予測の較正（wk1・全艇・45,184レース）')
push('艇番', '本数', 'モデルの平均予測(%)', '実際の1着率(%)', '差(pt)', '向き')
const wk = db.prepare(`SELECT lane,p,y FROM wk1`).all()
for (let L = 1; L <= 6; L++) {
  const s = wk.filter((r) => r.lane === L)
  const ap = s.reduce((a, r) => a + r.p, 0) / s.length
  const ay = s.reduce((a, r) => a + r.y, 0) / s.length
  push(L + '号艇', s.length, pc(ap), pc(ay), ((ap - ay) * 100).toFixed(2),
    Math.abs(ap - ay) * 100 < 0.5 ? '一致' : ap > ay ? '予測が高い' : '予測が低い')
}
push('')

// ---------- ② 本命に選んだ艇番ごと ----------
push('■②モデルが「最有力」に選んだ艇番ごとの成績')
push('本命の艇', '選んだ回数', '割合(%)', '予測平均(%)', '実際の的中(%)', '差(pt)')
const byRace = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()) {
  let a = byRace.get(r.race_id); if (!a) { a = []; byRace.set(r.race_id, a) }
  a.push(r)
}
const fav = []
for (const [, a] of byRace) if (a.length === 6) fav.push(a.reduce((m, x) => (x.p > m.p ? x : m)))
for (let L = 1; L <= 6; L++) {
  const s = fav.filter((r) => r.lane === L)
  if (!s.length) continue
  const ap = s.reduce((a, r) => a + r.p, 0) / s.length
  const ay = s.reduce((a, r) => a + r.y, 0) / s.length
  push(L + '号艇', s.length, pc(s.length / fav.length), pc(ap), pc(ay), ((ap - ay) * 100).toFixed(2))
}
push('')

// ---------- ③ 艇番×確率帯 ----------
push('■③艇番×確率帯の較正（ここに偏りがある）')
push('艇番', '確率帯', '本数', '予測(%)', '実際(%)', '差(pt)')
const BANDS = [[0, .05], [.05, .10], [.10, .20], [.20, .35], [.35, .55], [.55, .75], [.75, 1.01]]
for (let L = 1; L <= 6; L++)
  for (const [lo, hi] of BANDS) {
    const a = wk.filter((r) => r.lane === L && r.p >= lo && r.p < hi)
    if (a.length < 300) continue
    const ap = a.reduce((x, r) => x + r.p, 0) / a.length
    const ay = a.reduce((x, r) => x + r.y, 0) / a.length
    push(L + '号艇', `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`, a.length, pc(ap), pc(ay), ((ap - ay) * 100).toFixed(2))
  }
push('')

// ---------- ④ 条件ごとの成績 ----------
push('■④条件ごとの成績')
push('※「確定オッズで足切り」は締切後の値で選んでいるので実行できない。参考値')
push('券種', '足切りに使うオッズ', '条件', '点数', '本数/日', '的中(%)', '回収(%)', '月別100%超え')
const DL = new Map()
for (const r of db.prepare(`SELECT race_id,deadline FROM races WHERE deadline IS NOT NULL`).all()) {
  const [h, m] = r.deadline.split(':').map(Number)
  if (Number.isFinite(h)) DL.set(r.race_id, h * 60 + m)
}
for (const [t, mg, cap, lab] of [['tansho', MARGIN, 3, '単勝'], ['fukusho', FUKU.margin, 4, '複勝']]) {
  const rows = db.prepare(`SELECT race_id,date,p,odds,pay FROM bt WHERE bet_type=?`).all(t)
    .filter((x) => DL.has(x.race_id)).map((x) => ({ ...x, dl: DL.get(x.race_id) }))
  const bd = new Map()
  for (const x of rows.filter((x) => x.odds >= minOddsFor(x.p, mg))) {
    let a = bd.get(x.date); if (!a) { a = []; bd.set(x.date, a) } a.push(x)
  }
  const S = []
  for (const [, v] of bd) S.push(...v.sort((a, b) => a.dl - b.dl).slice(0, cap))
  const M = new Map()
  for (const x of S) { const q = M.get(x.date.slice(0, 7)) || [0, 0]; q[0]++; q[1] += x.pay; M.set(x.date.slice(0, 7), q) }
  let over = 0; for (const [, v] of M) if (v[1] / v[0] > 1) over++
  push(lab, '確定オッズ（実行不能）', `(1÷確率)×${mg}／1日${cap}本`, S.length,
    (S.length / bd.size).toFixed(2), pc(S.filter((x) => x.pay > 0).length / S.length),
    pc(S.reduce((a, x) => a + x.pay, 0) / S.length), `${over}/${M.size}`)
}
push('')

// ---------- ⑤ 月別 ----------
push('■⑤月別（確定オッズで足切りした場合）')
push('券種', '月', '点数', '的中(%)', '回収(%)')
for (const [t, mg, cap, lab] of [['tansho', MARGIN, 3, '単勝'], ['fukusho', FUKU.margin, 4, '複勝']]) {
  const rows = db.prepare(`SELECT race_id,date,p,odds,pay FROM bt WHERE bet_type=?`).all(t)
    .filter((x) => DL.has(x.race_id)).map((x) => ({ ...x, dl: DL.get(x.race_id) }))
  const bd = new Map()
  for (const x of rows.filter((x) => x.odds >= minOddsFor(x.p, mg))) {
    let a = bd.get(x.date); if (!a) { a = []; bd.set(x.date, a) } a.push(x)
  }
  const S = []
  for (const [, v] of bd) S.push(...v.sort((a, b) => a.dl - b.dl).slice(0, cap))
  const M = new Map()
  for (const x of S) { const q = M.get(x.date.slice(0, 7)) || [0, 0, 0]; q[0]++; q[1] += x.pay; if (x.pay > 0) q[2]++; M.set(x.date.slice(0, 7), q) }
  for (const [m, v] of [...M].sort()) push(lab, m, v[0], pc(v[2] / v[0]), pc(v[1] / v[0]))
}

const path = join(ROOT, 'data', 'summary.csv')
writeFileSync(path, out.join('\n'), 'utf8')
console.log(`${out.length}行 → ${path}`)
db.close()
