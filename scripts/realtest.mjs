// ★実オッズだけで回収率を測る。確定オッズは一切使わない。
//
//   node scripts/realtest.mjs
//
// なぜ要るか
//   backtest.mjs は odds_tan（確定オッズ）で足切りしている。確定オッズは
//   締切後にしか分からないので、あの回収率は「買う時点で知り得ない値で選んだ」数字。
//   実運用で使えるのは締切前オッズ（odds_live）だけ。
//   **締切前オッズで足切りして、実払戻で採点する。** これが唯一の実証。
//
// 制約（正直に書く）
//   odds_live は 2026-08-20 から記録。複勝下限は 2026-08-23 18:16 から。
//   払戻は前日分までしか入らない。よって測れる日数はごく少ない。
//   少ないことは書くが、少ないから省略はしない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { minOddsFor, MARGIN, FUKU, FUKU90, CHECK_FROM, CHECK_UNTIL } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

// ---------- 実払戻 ----------
const PAY = { tansho: new Map(), fukusho: new Map() }
for (const t of ['tansho', 'fukusho'])
  for (const r of db.prepare(`SELECT race_id,combo,amount FROM payouts WHERE bet_type=? AND amount>0`).all(t))
    PAY[t].set(r.race_id + '|' + r.combo, r.amount / 100)

// ---------- 締切前オッズ（実際に見えていた値だけ） ----------
// auto-bet と同じ手順：締切 CHECK_FROM〜CHECK_UNTIL 分前で、最も早くプールが
// 形成されている読みを使う。プール未形成は Σ(1/オッズ) で弾く。
function liveOdds(col, sumLo, sumHi) {
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
      const sum = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (sum < sumLo || sum > sumHi) continue
      out.set(rid, o); break
    }
  return out
}
const TAN = liveOdds('tansho', 1.15, 1.60)
const FUK = liveOdds('fukusho_lo', FUKU.sumLo, FUKU.sumHi)

// ---------- モデルの本命 ----------
// ★bt（歩進検証の表）は使わない。bt は walk.mjs の学習範囲までしか無く、
//   直近数日が入らない（8/22まで）。**本番が実際に出した予想ファイル**を読む。
//   data/predict-YYYY-MM-DD.json はその日の朝に作られた本物の予想。
const FAV = { tansho: new Map(), fukusho: new Map() }
{
  const dir = join(ROOT, 'data')
  // ★正規表現をシェル経由で書くとバックスラッシュが消える。[0-9] を使う
  for (const f of readdirSync(dir).filter((x) => /^predict-[0-9-]{10}[.]json$/.test(x))) {
    let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    for (const x of j.races ?? []) {
      const a = x.first?.[0], b = x.top2?.[0]
      if (a) FAV.tansho.set(x.race_id, { lane: a.lane, p: a.p })
      if (b) FAV.fukusho.set(x.race_id, { lane: b.lane, p: b.p })
    }
  }
  console.log(`予想ファイル 単勝${FAV.tansho.size}レース／複勝${FAV.fukusho.size}レース
`)
}

// ---------- 締切時刻 ----------
const DL = new Map()
for (const r of db.prepare(`SELECT race_id,deadline FROM races WHERE deadline IS NOT NULL`).all()) {
  const [h, m] = r.deadline.split(':').map(Number)
  if (Number.isFinite(h)) DL.set(r.race_id, h * 60 + m)
}

// 結果（着順・払戻）が入っているレースの一覧。入っていない日は採点しない。
const hasRes = new Set(db.prepare(`SELECT DISTINCT race_id FROM payouts`).all().map((r) => r.race_id))

const RULES = [
  { key: 'tansho', label: '単勝', src: TAN, cap: 3,
    need: (p) => minOddsFor(p, MARGIN), cond: `必要倍率=(1÷確率)×${MARGIN}／1日3本` },
  { key: 'fukusho', label: '複勝', src: FUK, cap: FUKU.maxBuy,
    need: (p) => minOddsFor(p, FUKU.margin), cond: `必要倍率=(1÷確率)×${FUKU.margin}／1日${FUKU.maxBuy}本` },
  { key: 'fukusho', label: '複勝・高的中', src: FUK, cap: FUKU90.maxBuy, minP: FUKU90.minP,
    ng: new Set(FUKU90.badVenues), need: () => FUKU90.minOdds,
    cond: `確率${FUKU90.minP * 100}%以上×${FUKU90.minOdds}倍以上／1日${FUKU90.maxBuy}本` },
]

console.log('═══ 実オッズだけで測った回収率 ═══')
console.log('締切前オッズで足切り → 実払戻で採点。確定オッズは使っていない。\n')

for (const R of RULES) {
  const rows = []
  for (const [rid, f] of FAV[R.key]) {
    if (R.minP != null && f.p < R.minP) continue
    if (R.ng && R.ng.has(Number(rid.slice(9, 11)))) continue
    const o = R.src.get(rid)?.get(f.lane)
    const dl = DL.get(rid)
    if (o == null || dl == null) continue
    rows.push({ rid, day: rid.slice(0, 8), dl, p: f.p, o, need: R.need(f.p),
      pay: PAY[R.key].get(rid + '|' + f.lane) ?? 0, settled: hasRes.has(rid) })
  }
  const usable = rows.filter((x) => x.settled)
  const buys = []
  const byDay = new Map()
  for (const x of usable.filter((x) => x.o >= x.need)) {
    let a = byDay.get(x.day); if (!a) { a = []; byDay.set(x.day, a) }
    a.push(x)
  }
  for (const [, v] of byDay) buys.push(...v.sort((a, b) => a.dl - b.dl).slice(0, R.cap))

  console.log(`── ${R.label}　${R.cond}`)
  console.log(`   採点できるレース ${usable.length}本（${new Set(usable.map((x) => x.day)).size}日分）`)
  if (!buys.length) { console.log('   条件を満たした買い目なし\n'); continue }
  const hit = buys.filter((x) => x.pay > 0)
  const ret = buys.reduce((a, x) => a + x.pay, 0)
  console.log(`   買い ${buys.length}本　的中${hit.length}本（${(hit.length / buys.length * 100).toFixed(1)}%）`)
  console.log(`   投資${buys.length * 100}円 払戻${Math.round(ret * 100)}円 収支${ret * 100 - buys.length * 100 >= 0 ? '+' : ''}${Math.round(ret * 100 - buys.length * 100)}円　**回収${(ret / buys.length * 100).toFixed(1)}%**`)
  for (const x of buys)
    console.log(`     ${x.day.slice(4, 6)}/${x.day.slice(6)} ${String(Math.floor(x.dl / 60)).padStart(2, '0')}:${String(x.dl % 60).padStart(2, '0')} 確率${(x.p * 100).toFixed(0)}% 締切前${x.o.toFixed(1)}倍(必要${x.need.toFixed(2)}) → ${x.pay > 0 ? '的中 ' + Math.round(x.pay * 100) + '円' : 'はずれ'}`)
  console.log('')
}

db.close()
