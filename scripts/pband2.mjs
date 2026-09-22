// 低確率帯（0〜5%）の中身を見る。ブレの大きさと、利益がどれだけ偏っているか。
//   node --max-old-space-size=8192 scripts/pband2.mjs
//
// ★なぜ見るか
//   0〜5%の帯は回収276.9%だが的中は3.33%。1日13本買って月に十数本しか当たらない。
//   「平均すればプラス」でも、当たりが数本の大穴に偏っているなら、
//   実際に続けるときの資金の減り方がまるで違う。
//   [[boatrace-tansho-edge2]] の「平均が合うことと閾値判定が当たることは別」と同じ注意。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { PB, OB, binOf } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const CAL = (() => {
  const M = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p, y FROM wi1`).iterate()) {
    const od = OD.get(r.race_id + '|' + r.lane); if (!(od > 0)) continue
    const k = binOf(PB, r.p) + '|' + binOf(OB, od)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.y; a.sp += r.p
  }
  const c = new Map()
  for (const [k, a] of M) { const w = a.n / (a.n + 300); c.set(k, (w * (a.h / a.n) + (1 - w) * (a.sp / a.n)) / Math.max(a.sp / a.n, 1e-9)) }
  return c
})()
const cal = (p, o) => { const x = CAL.get(binOf(PB, p) + '|' + binOf(OB, o)); return x ? Math.min(0.999, Math.max(1e-6, p * x)) : p }

const bets = []
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).iterate()) {
  const o = OD.get(r.race_id + '|' + r.lane); if (!(o > 0)) continue
  const p = cal(r.p, o); if (o < (1 / p) * S.MARGIN) continue
  bets.push({ p, o, y: r.y, mo: r.month, day: r.race_id.slice(0, 8),
    ret: r.y === 1 ? (PAY.get(r.race_id + '|' + r.lane) ?? o * 100) : 0 })
}
const DAYS = new Set(bets.map((b) => b.day)).size
console.log(`歩進検証 ${DAYS}日 / 買い ${bets.length.toLocaleString()}本\n`)

for (const [lo, hi, nm] of [[0, 0.05, '0〜5%'], [0, 0.15, '0〜15%'], [0, 0.30, '0〜30%'], [0.30, 1.01, '30%以上']]) {
  const a = bets.filter((b) => b.p >= lo && b.p < hi)
  const hits = a.filter((b) => b.y === 1).sort((x, y) => y.ret - x.ret)
  const ret = a.reduce((s, b) => s + b.ret, 0)
  const pl = ret - a.length * 100
  console.log(`【${nm}】${a.length.toLocaleString()}本 / 的中 ${hits.length}本(${(hits.length / a.length * 100).toFixed(2)}%) / 回収 ${(ret / (a.length * 100) * 100).toFixed(1)}%`)
  // 利益の偏り
  for (const k of [1, 3, 5, 10]) {
    if (hits.length < k) continue
    const top = hits.slice(0, k).reduce((s, b) => s + b.ret, 0)
    console.log(`    払戻の大きい上位${String(k).padStart(2)}本だけで 払戻の ${(top / ret * 100).toFixed(1)}% / 利益の ${(top / pl * 100).toFixed(1)}%`)
  }
  // 月ごと
  const per = new Map()
  for (const b of a) { let x = per.get(b.mo); if (!x) { x = { n: 0, g: 0 }; per.set(b.mo, x) } x.n++; x.g += b.ret }
  const ms = [...per].sort()
  console.log('    月ごとの回収: ' + ms.map(([m, x]) => `${m.slice(5)} ${(x.g / (x.n * 100) * 100).toFixed(0)}%`).join(' '))
  console.log(`    プラスの月 ${ms.filter(([, x]) => x.g > x.n * 100).length}/${ms.length}`)
  // 連続で外す長さ（資金の減り方の目安）
  let run = 0, worst = 0
  for (const b of a) { if (b.y === 1) run = 0; else { run++; if (run > worst) worst = run } }
  console.log(`    最長の連続はずれ ${worst}本（${(worst / (a.length / DAYS)).toFixed(1)}日ぶん）`)
  // 100円買いでの資金の底
  let cum = 0, peak = 0, dd = 0
  for (const b of a) { cum += b.ret - 100; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum }
  console.log(`    いちばん深い落ち込み ${dd.toLocaleString()}円（最終損益 ${(pl > 0 ? '+' : '') + pl.toLocaleString()}円）\n`)
}
db.close()
