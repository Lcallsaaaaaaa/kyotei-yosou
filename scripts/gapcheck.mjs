// 「検証で買える集合」と「実運用で買える集合」がどれだけ一致するかを測る。
//
//   node scripts/gapcheck.mjs
//
// ★これで何が分かるか
//   backtest.mjs は確定オッズで足切りしている。実運用は締切前オッズしか見えない。
//   同じ条件を両方のオッズに当てて、選ばれる集合を突き合わせる。
//     ・一致率が高い → 検証の回収率はおおむね実現できる。3日の負けは運
//     ・一致率が低い → 実運用は別物を買っている。運の問題ではない
//
// ★odds_live のある日だけが対象（2026-08-20〜）。それが今ある全部。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor, MARGIN, FUKU, CHECK_FROM, CHECK_UNTIL } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

// 締切前オッズ（auto-bet と同じ取り出し方）
function live(col, sumLo, sumHi) {
  const byRace = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE mins_before BETWEEN ? AND ? AND ${col} > 0`).all(CHECK_UNTIL, CHECK_FROM)) {
    let m = byRace.get(r.race_id); if (!m) { m = new Map(); byRace.set(r.race_id, m) }
    let o = m.get(r.mins_before); if (!o) { o = new Map(); m.set(r.mins_before, o) }
    o.set(r.lane, r.v)
  }
  const out = new Map()
  for (const [rid, byMin] of byRace)
    for (const mins of [...byMin.keys()].sort((a, b) => b - a)) {
      const o = byMin.get(mins)
      if (o.size < 4) continue
      const s = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (s < sumLo || s > sumHi) continue
      out.set(rid, o); break
    }
  return out
}
const LT = live('tansho', 1.15, 1.60)
const LF = live('fukusho_lo', FUKU.sumLo, FUKU.sumHi)

for (const [t, src, mg, lab] of [['tansho', LT, MARGIN, '単勝'], ['fukusho', LF, FUKU.margin, '複勝']]) {
  const rows = db.prepare(`SELECT race_id,date,p,odds,pay FROM bt WHERE bet_type=?`).all(t)
    .filter((x) => src.has(x.race_id))
  if (!rows.length) { console.log(`\n${lab}：締切前オッズと突き合わせられるレースなし`); continue }
  const days = [...new Set(rows.map((x) => x.date))].sort()

  let A = [], B = []            // A=確定で通る（検証）／B=締切前で通る（実運用）
  for (const x of rows) {
    const pre = src.get(x.race_id).get(
      db.prepare(`SELECT lane FROM bt WHERE race_id=? AND bet_type=?`).get(x.race_id, t).lane)
    if (pre == null) continue
    const need = minOddsFor(x.p, mg)
    if (x.odds >= need) A.push({ ...x, pre })
    if (pre >= need) B.push({ ...x, pre })
  }
  const key = (x) => x.race_id
  const setA = new Set(A.map(key)), setB = new Set(B.map(key))
  const both = A.filter((x) => setB.has(key(x)))
  const st = (S) => S.length
    ? `${String(S.length).padStart(3)}本 的中${(S.filter((x) => x.pay > 0).length / S.length * 100).toFixed(1)}% 回収${(S.reduce((a, x) => a + x.pay, 0) / S.length * 100).toFixed(1)}%`
    : '0本'

  console.log(`\n══ ${lab}　必要倍率=(1÷確率)×${mg}　対象 ${rows.length}レース（${days.length}日：${days.map((d) => d.slice(5)).join(' ')}）══`)
  console.log(`  A 確定オッズで通る（＝検証が買う）   ${st(A)}`)
  console.log(`  B 締切前オッズで通る（＝実運用が買う） ${st(B)}`)
  console.log(`  A∩B 両方で通る                      ${st(both)}`)
  console.log(`  → 実運用が買う${B.length}本のうち、検証も買うのは ${both.length}本（${B.length ? (both.length / B.length * 100).toFixed(0) : 0}%）`)
  console.log(`  → 検証が買う${A.length}本のうち、実運用も買えるのは ${both.length}本（${A.length ? (both.length / A.length * 100).toFixed(0) : 0}%）`)

  const onlyB = B.filter((x) => !setA.has(key(x)))
  if (onlyB.length) {
    console.log(`\n  実運用だけが買う${onlyB.length}本（締切前は条件を満たすが確定は満たさない）`)
    for (const x of onlyB.slice(0, 12))
      console.log(`    ${x.date.slice(5)} 確率${(x.p * 100).toFixed(0)}% 必要${minOddsFor(x.p, mg).toFixed(2)}倍  締切前${x.pre.toFixed(1)}倍 → 確定${x.odds.toFixed(1)}倍  ${x.pay > 0 ? '的中' : 'はずれ'}`)
    if (onlyB.length > 12) console.log(`    …他${onlyB.length - 12}本`)
  }
}
db.close()
