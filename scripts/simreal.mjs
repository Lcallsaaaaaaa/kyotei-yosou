// 8ヶ月分を「実オッズ相当」で検証し直す。
//
//   node --max-old-space-size=8192 scripts/simreal.mjs
//
// ★何をするか
//   公式は過去の締切前オッズを出していない。だが odds_live に
//   「締切前オッズ ↔ 確定オッズ」の実測ペアが6日分ある。
//   そこから **確定オッズ → 締切前オッズ** の変換分布を作り、
//   8ヶ月36,085レースの確定オッズに当てて締切前オッズを再現する。
//
//   ・買うかどうかは **再現した締切前オッズ** で決める（＝買う時点で見える値）
//   ・受け取るのは **実払戻**（payouts.amount）。ここは本物
//
// ★これは推定であって実測ではない
//   6日分のズレ方が8ヶ月に当てはまる、という仮定を置いている。
//   だから点推定ではなく、1,000回引き直して **区間** で出す。
//   仮定が外れていればこの数字も外れる。そこは数字と一緒に必ず書く。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor, MARGIN, FUKU, FUKU90, CHECK_FROM, CHECK_UNTIL } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const rng = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------- 1) 実測ペアを集める ----------
// auto-bet と同じ手順で「その日その時に見えていた」オッズを取り出す。
function livePairs(col, finCol, sumLo, sumHi) {
  const byRace = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE mins_before BETWEEN ? AND ? AND ${col} > 0`).all(CHECK_UNTIL, CHECK_FROM)) {
    let m = byRace.get(r.race_id); if (!m) { m = new Map(); byRace.set(r.race_id, m) }
    let o = m.get(r.mins_before); if (!o) { o = new Map(); m.set(r.mins_before, o) }
    o.set(r.lane, r.v)
  }
  const fin = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,${finCol} v FROM odds_tan WHERE ${finCol} > 0`).all())
    fin.set(r.race_id + '|' + r.lane, r.v)

  const pairs = []
  for (const [rid, byMin] of byRace)
    for (const mins of [...byMin.keys()].sort((a, b) => b - a)) {
      const o = byMin.get(mins)
      if (o.size < 4) continue
      const sum = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (sum < sumLo || sum > sumHi) continue
      for (const [lane, pre] of o) {
        const f = fin.get(rid + '|' + lane)
        if (f != null && f > 0) pairs.push({ pre, fin: f, r: pre / f })   // 確定→締切前の比
      }
      break
    }
  return pairs
}

// ---------- 2) 確定オッズ帯ごとに「締切前 ÷ 確定」の分布を作る ----------
// オッズ帯で分けるのは、高オッズ艇ほど締切間際に買われて下がるため。
// 実測（2026-08-24）で買った9本すべて確定が判定時を下回り、中央39%だった。
const BANDS = [[0, 1.5], [1.5, 2.5], [2.5, 4], [4, 7], [7, 12], [12, 25], [25, 1e9]]
function buildDist(pairs) {
  const d = BANDS.map(() => [])
  for (const p of pairs) {
    const i = BANDS.findIndex(([lo, hi]) => p.fin >= lo && p.fin < hi)
    if (i >= 0 && Number.isFinite(p.r) && p.r > 0) d[i].push(p.r)
  }
  for (const a of d) a.sort((x, y) => x - y)
  return d
}
const pick = (d, fin, rand) => {
  const i = BANDS.findIndex(([lo, hi]) => fin >= lo && fin < hi)
  const a = d[i] ?? []
  if (!a.length) return 1
  return a[(rand() * a.length) | 0]
}

const TP = livePairs('tansho', 'tansho', 1.15, 1.60)
const FP = livePairs('fukusho_lo', 'fukusho_lo', FUKU.sumLo, FUKU.sumHi)
const TD = buildDist(TP), FD = buildDist(FP)

const q = (a, x) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * x))] : NaN
console.log('═══ 実測ペア（締切前オッズ ÷ 確定オッズ）═══')
console.log('確定オッズ帯      件数    中央    下位25%  上位25%   1.0未満＝確定のほうが低い')
for (let i = 0; i < BANDS.length; i++) {
  const [lo, hi] = BANDS[i], a = TD[i]
  if (a.length < 30) continue
  console.log(`  単勝 ${String(lo).padStart(4)}〜${hi > 1e8 ? '∞' : String(hi).padStart(3)}  ${String(a.length).padStart(6)}  ${q(a, .5).toFixed(2).padStart(6)}  ${q(a, .25).toFixed(2).padStart(7)}  ${q(a, .75).toFixed(2).padStart(7)}`)
}
for (let i = 0; i < BANDS.length; i++) {
  const [lo, hi] = BANDS[i], a = FD[i]
  if (a.length < 30) continue
  console.log(`  複勝 ${String(lo).padStart(4)}〜${hi > 1e8 ? '∞' : String(hi).padStart(3)}  ${String(a.length).padStart(6)}  ${q(a, .5).toFixed(2).padStart(6)}  ${q(a, .25).toFixed(2).padStart(7)}  ${q(a, .75).toFixed(2).padStart(7)}`)
}
console.log(`  （単勝ペア ${TP.length.toLocaleString()}件／複勝ペア ${FP.length.toLocaleString()}件・2026-08-20〜25）\n`)

// ---------- 3) 8ヶ月に当てて回す ----------
const DL = new Map()
for (const r of db.prepare(`SELECT race_id,deadline FROM races WHERE deadline IS NOT NULL`).all()) {
  const [h, m] = r.deadline.split(':').map(Number)
  if (Number.isFinite(h)) DL.set(r.race_id, h * 60 + m)
}
const rowsOf = (t) => db.prepare(`SELECT race_id,date,p,odds,pay,jcd FROM bt WHERE bet_type=?`).all(t)
  .filter((x) => DL.has(x.race_id)).map((x) => ({ ...x, dl: DL.get(x.race_id) }))
const TROWS = rowsOf('tansho'), FROWS = rowsOf('fukusho')

const RULES = [
  { label: '単勝', rows: TROWS, dist: TD, cap: 3, need: (p) => minOddsFor(p, MARGIN),
    cond: `必要倍率=(1÷確率)×${MARGIN}／1日3本` },
  { label: '複勝', rows: FROWS, dist: FD, cap: FUKU.maxBuy, need: (p) => minOddsFor(p, FUKU.margin),
    cond: `必要倍率=(1÷確率)×${FUKU.margin}／1日${FUKU.maxBuy}本` },
  { label: '複勝・高的中', rows: FROWS.filter((x) => x.p >= FUKU90.minP && !FUKU90.badVenues.includes(x.jcd)),
    dist: FD, cap: FUKU90.maxBuy, need: () => FUKU90.minOdds,
    cond: `確率${FUKU90.minP * 100}%以上×${FUKU90.minOdds}倍以上／1日${FUKU90.maxBuy}本` },
]

const TRIALS = 1000
console.log('═══ 8ヶ月を「実オッズ相当」で回した結果（1,000回の引き直し）═══')
console.log('買うかどうか＝再現した締切前オッズ。受け取り＝実払戻。\n')
for (const R of RULES) {
  const byDay = new Map()
  for (const x of R.rows) { let a = byDay.get(x.date); if (!a) { a = []; byDay.set(x.date, a) } a.push(x) }
  for (const [, v] of byDay) v.sort((a, b) => a.dl - b.dl)

  const rois = [], ns = [], hits = []
  for (let t = 0; t < TRIALS; t++) {
    const rand = rng(1000 + t)
    let n = 0, ret = 0, hit = 0
    for (const [, v] of byDay) {
      let c = 0
      for (const x of v) {
        if (c >= R.cap) break
        const pre = x.odds * pick(R.dist, x.odds, rand)   // 確定 → 締切前を再現
        if (pre < R.need(x.p)) continue
        c++; n++; ret += x.pay; if (x.pay > 0) hit++
      }
    }
    if (n) { rois.push(ret / n); ns.push(n); hits.push(hit / n) }
  }
  rois.sort((a, b) => a - b); ns.sort((a, b) => a - b); hits.sort((a, b) => a - b)
  console.log(`── ${R.label}　${R.cond}`)
  if (!rois.length) { console.log('   買い目なし\n'); continue }
  console.log(`   買い ${q(ns, .5)}本（8ヶ月）　的中 ${(q(hits, .5) * 100).toFixed(1)}%`)
  console.log(`   回収率 中央 **${(q(rois, .5) * 100).toFixed(1)}%**　90%区間 [${(q(rois, .05) * 100).toFixed(1)}%, ${(q(rois, .95) * 100).toFixed(1)}%]`)
  console.log(`   100%を割る確率 ${(rois.filter((v) => v < 1).length / TRIALS * 100).toFixed(1)}%`)
  console.log(`   （参考）確定オッズで足切りした場合＝先読み\n`)
}
db.close()
