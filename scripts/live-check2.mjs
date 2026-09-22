// いま動いている判定そのままの成績を出す。
//   node --max-old-space-size=6144 scripts/live-check2.mjs
//
// 設定は strategy.mjs と calib.mjs から読む。数字をここに書かない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, shouldBuy } from './calib.mjs'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
console.log(`設定: 余裕${S.MARGIN} / 全6艇=${S.ALL_LANES} / 校正=${S.USE_CALIB} / 上限${S.MAX_BUY}本\n`)
const CAL = S.USE_CALIB ? loadCalib(db, 'wi1') : null
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
let races = 0, bets = 0, hit = 0, ret = 0
const per = new Map()
const byRaceBets = new Map()
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = OD.get(rid); if (!o) continue
  races++
  let nb = 0
  const cand = S.ALL_LANES ? bs : [bs.reduce((a, b) => (b.p > a.p ? b : a))]
  for (const b of cand) {
    const od = o[b.lane]
    if (!(od > 0)) continue
    const r = CAL ? shouldBuy(CAL, b.p, od, S.MARGIN) : { buy: od >= (1 / b.p) * S.MARGIN }
    if (!r.buy) continue
    bets++; nb++
    let a = per.get(b.month); if (!a) { a = { b: 0, h: 0, r: 0 }; per.set(b.month, a) }
    a.b++
    if (b.y === 1) { hit++; const p = PAY.get(rid + '|' + b.lane) ?? od * 100; ret += p; a.h++; a.r += p }
  }
  byRaceBets.set(nb, (byRaceBets.get(nb) ?? 0) + 1)
}
const days = races / 149.6
console.log(`対象 ${races.toLocaleString()}レース（${(days).toFixed(0)}日ぶん）`)
console.log('')
console.log(`  買った数        ${bets.toLocaleString()}本（1日 ${(bets / days).toFixed(1)}本）`)
console.log(`  **的中率**      ${(hit / bets * 100).toFixed(2)}%（${hit.toLocaleString()}本的中）`)
console.log(`  平均払戻        ${(ret / hit).toFixed(0)}円`)
console.log(`  回収率          ${(ret / (bets * 100) * 100).toFixed(2)}%`)
console.log(`  1日100円買いの損益 ${((ret - bets * 100) / days).toFixed(0)}円`)
console.log('')
console.log('月ごと')
for (const [mo, a] of [...per].sort()) {
  if (a.b < 30) continue
  console.log(`  ${mo}  ${String(a.b).padStart(5)}本  的中${(a.h / a.b * 100).toFixed(2).padStart(6)}%  回収${(a.r / (a.b * 100) * 100).toFixed(2).padStart(7)}%`)
}
console.log('')
console.log('1レースで何本買うか')
for (const [n, v] of [...byRaceBets].sort((a, b) => a[0] - b[0]))
  console.log(`  ${n}本  ${String(v).padStart(6)}レース (${(v / races * 100).toFixed(1)}%)`)
db.close()
