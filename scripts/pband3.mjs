// 低確率（＝高オッズ）の艇ほど、締切前オッズと確定オッズがズレていないか。
//   node --max-old-space-size=8192 scripts/pband3.mjs
//
// ★なぜ見るか
//   回収率の計算は確定オッズ(odds_tan)で出している。だが実際に買うのは締切2〜3分前で、
//   そのときのオッズしか分からない。[[boatrace-odds-timing]] のとおり
//   締切0分前でも確定と±10%以内は23.5%しかない。
//   低確率の艇は高オッズなので、ズレが大きいと 0〜5%帯の276.9% は成り立たない。
//
// ★使うのは odds_live（締切前に実際に見えた単勝オッズ）
//   これは odds-live.mjs が集めたもの。mins_before が小さいほど締切に近い。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
// 締切にいちばん近い時点の値を採る
const LIVE = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho, mins_before FROM odds_live
    WHERE tansho IS NOT NULL AND mins_before IS NOT NULL ORDER BY mins_before DESC`).iterate())
  LIVE.set(r.race_id + '|' + r.lane, { o: r.tansho, m: r.mins_before })
console.log(`締切前オッズ ${LIVE.size.toLocaleString()}件（${new Set([...LIVE.keys()].map((k) => k.slice(0, 8))).size}日ぶん）`)

const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const CAL = loadCalib(db, 'wi1')

// 締切前オッズがある買い目だけを対象にする
const rows = []
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).iterate()) {
  const k = r.race_id + '|' + r.lane
  const fin = OD.get(k), lv = LIVE.get(k)
  if (!(fin > 0) || !lv) continue
  rows.push({ ...r, fin, live: lv.o, mins: lv.m })
}
console.log(`両方そろった買い目 ${rows.length.toLocaleString()}本\n`)
if (!rows.length) { console.log('締切前オッズが無いので測れない'); db.close(); process.exit(0) }

const BANDS = [0, 0.05, 0.10, 0.15, 0.30, 1.01]
const lab = (i) => `${(BANDS[i] * 100).toFixed(0)}〜${BANDS[i + 1] > 1 ? '100' : (BANDS[i + 1] * 100).toFixed(0)}%`

console.log('【判定に使う締切前オッズが、確定オッズとどれだけ違うか】')
console.log('  帯          本数   締切前の中央値  確定の中央値   ズレの中央値  確定のほうが低い割合')
for (let i = 0; i < BANDS.length - 1; i++) {
  // 帯は「確定オッズで校正した確率」で切る（帯の定義を前の計測とそろえる）
  const a = rows.filter((r) => { const p = calibrate(CAL, r.p, r.fin); return p >= BANDS[i] && p < BANDS[i + 1] })
  if (a.length < 30) continue
  const md = (v) => { const s = v.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const gap = a.map((r) => (r.fin / r.live - 1) * 100)
  const down = a.filter((r) => r.fin < r.live).length
  console.log(`  ${lab(i).padEnd(9)} ${String(a.length).padStart(6)} ${md(a.map((r) => r.live)).toFixed(1).padStart(13)}倍 ` +
    `${md(a.map((r) => r.fin)).toFixed(1).padStart(11)}倍 ${md(gap).toFixed(1).padStart(11)}% ${(down / a.length * 100).toFixed(1).padStart(15)}%`)
}

// 判定と回収を「締切前オッズで判定し、払戻は確定」で出し直す
console.log('\n【締切前オッズで判定した場合の実際の回収率】')
console.log('  足切り     本数    1日   的中率   回収率(締切前判定)   参考:確定オッズで判定')
const DAYS = new Set(rows.map((r) => r.race_id.slice(0, 8))).size
for (const th of [0, 0.05, 0.10, 0.15, 0.30]) {
  const run = (useLive) => {
    let n = 0, hit = 0, ret = 0
    for (const r of rows) {
      const o = useLive ? r.live : r.fin
      const p = calibrate(CAL, r.p, o)
      if (p < th) continue
      if (o < (1 / p) * S.MARGIN) continue
      n++
      if (r.y === 1) { hit++; ret += PAY.get(r.race_id + '|' + r.lane) ?? r.fin * 100 }
    }
    return { n, hit, roi: n ? ret / (n * 100) * 100 : 0, pl: ret - n * 100 }
  }
  const L = run(true), F = run(false)
  if (!L.n) continue
  console.log(`  ${(th * 100).toFixed(0).padStart(3)}%以上 ${String(L.n).padStart(7)} ${(L.n / DAYS).toFixed(1).padStart(6)} ` +
    `${(L.hit / L.n * 100).toFixed(2).padStart(7)}% ${L.roi.toFixed(1).padStart(15)}% ${F.roi.toFixed(1).padStart(20)}%`)
}
console.log('\n※ 払戻は確定（実際に受け取る額）。判定だけを締切前オッズで行っている。')
db.close()
