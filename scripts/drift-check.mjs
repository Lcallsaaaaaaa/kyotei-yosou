// 「締切前のオッズで判定したら回収率がどうなるか」を、本番の予想そのもので測る。
//   node --max-old-space-size=8192 scripts/drift-check.mjs
//
// ★なぜこの作りか
//   回収率の計算はふつう確定オッズ(odds_tan)で出す。だが実際に買うのは締切前で、
//   そのときのオッズしか分からない。[[boatrace-odds-timing]] のとおり
//   締切0分前でも確定と±10%以内は23.5%しかない。
//   歩進検証(wi1)は 2026-08-25 までで、締切前オッズ(odds_live)は 08-20 から。
//   重なりが6日しかないので、**当日に出した予想JSON**（本番モデルそのもの）を使う。
//   data/predict-YYYY-MM-DD.json の first[] が当日の1着確率。
//
// ★何と何を比べるか
//   同じ買い目候補に対して
//     ① 締切前オッズで判定 → 買った分の払戻は確定額
//     ② 確定オッズで判定   → 同上
//   ①が実際にできること。②は測るときだけ使える幻。差が「オッズのズレの代償」。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
// 締切にいちばん近い時点の値（mins_before の大きい順に上書きするので最後に小さいものが残る）
const LIVE = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho, mins_before FROM odds_live
    WHERE tansho IS NOT NULL AND mins_before IS NOT NULL ORDER BY mins_before DESC`).iterate())
  LIVE.set(r.race_id + '|' + r.lane, { o: r.tansho, m: r.mins_before })
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1`).iterate())
  WIN.set(r.race_id, r.lane)
const CAL = loadCalib(db, 'wi1')

// 当日に出した予想を読む
const rows = []
const days = new Set()
for (const f of readdirSync(join(ROOT, 'data')).filter((x) => /^predict-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'))
  for (const r of (j.races ?? [])) {
    const win = WIN.get(r.race_id)
    if (win == null) continue                       // まだ結果が入っていない
    for (const b of (r.first ?? [])) {
      const k = r.race_id + '|' + b.lane
      const fin = OD.get(k), lv = LIVE.get(k)
      if (!(fin > 0) || !lv) continue               // 両方そろっているものだけ
      rows.push({ id: r.race_id, lane: b.lane, p: b.p, fin, live: lv.o, mins: lv.m,
        y: win === b.lane ? 1 : 0, day: r.race_id.slice(0, 8) })
      days.add(r.race_id.slice(0, 8))
    }
  }
}
console.log(`本番の予想 × 締切前オッズ × 確定結果 が全部そろった買い目 ${rows.length.toLocaleString()}本（${days.size}日）`)
if (!rows.length) { db.close(); process.exit(0) }
console.log(`締切までの残り時間の中央値 ${(() => { const s = rows.map((r) => r.mins).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] })()}分\n`)

function run(useLive, th) {
  let n = 0, hit = 0, ret = 0
  const per = new Map()
  for (const r of rows) {
    const o = useLive ? r.live : r.fin
    const p = calibrate(CAL, r.p, o)
    if (p < th) continue
    if (o < (1 / p) * S.MARGIN) continue
    n++
    const g = r.y === 1 ? (PAY.get(r.id + '|' + r.lane) ?? r.fin * 100) : 0
    if (r.y === 1) hit++
    ret += g
    let a = per.get(r.day); if (!a) { a = { n: 0, g: 0 }; per.set(r.day, a) }
    a.n++; a.g += g
  }
  const pos = [...per.values()].filter((a) => a.g > a.n * 100).length
  return { n, hit, roi: n ? ret / (n * 100) * 100 : 0, pl: ret - n * 100, pos, days: per.size }
}

console.log('【締切前オッズで判定（＝実際にできること）】')
console.log('  足切り    本数   1日   的中率   回収率     損益   プラスの日')
for (const th of [0, 0.05, 0.10, 0.15, 0.30]) {
  const a = run(true, th); if (!a.n) continue
  console.log(`  ${(th * 100).toFixed(0).padStart(3)}%以上 ${String(a.n).padStart(6)} ${(a.n / days.size).toFixed(1).padStart(6)} ` +
    `${(a.hit / a.n * 100).toFixed(2).padStart(7)}% ${a.roi.toFixed(1).padStart(7)}% ` +
    `${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} ${a.pos}/${a.days}`)
}
console.log('\n【確定オッズで判定（測るときだけ使える幻）】')
console.log('  足切り    本数   1日   的中率   回収率     損益   プラスの日')
for (const th of [0, 0.05, 0.10, 0.15, 0.30]) {
  const a = run(false, th); if (!a.n) continue
  console.log(`  ${(th * 100).toFixed(0).padStart(3)}%以上 ${String(a.n).padStart(6)} ${(a.n / days.size).toFixed(1).padStart(6)} ` +
    `${(a.hit / a.n * 100).toFixed(2).padStart(7)}% ${a.roi.toFixed(1).padStart(7)}% ` +
    `${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} ${a.pos}/${a.days}`)
}
console.log(`\n※ ${days.size}日ぶんしかない。1日100円・100点たまるまでは判断材料にしない。`)
db.close()
