// 過去のレースで「締切前オッズで判定したらどうなるか」をシミュレーションする。
//   node --max-old-space-size=8192 scripts/sim-drift.mjs
//   node --max-old-space-size=8192 scripts/sim-drift.mjs --draws 20 --fuku
//
// ★なぜシミュレーションなのか
//   締切前オッズは odds_live にしか無く、健全な記録は8〜9日ぶんしかない。
//   公式は終わったレースの締切前オッズを出さないので、**過去に遡って実測はできない**。
//   そこで、実測したズレの分布を過去の確定オッズに逆向きに当てて、
//   「もし締切前にこう見えていたら」を作って判定し直す。
//
// ★これは実測ではない。しかも楽観側に出る
//   ズレには2種類ある。
//     ① 雑音   … 締切前の表示は確定のブレた値。高く出ている艇を選ぶと下がる（回帰）
//     ② 情報   … 締切間際の金は「展示を見た人」の金。下がる艇は実際に弱い
//   ここで再現できるのは①だけ。②があるなら現実はもっと悪い。
//   **つまりこの結果が100%を割るなら現実も割る。超えても現実は超えるとは限らない。**
//
// ★時点を守る
//   ズレの分布は「健全な締切前オッズ(ok=1)」だけから作る。壊れた記録を混ぜると
//   ありもしない大穴が生まれる（実際に混ぜて回収83.4%と誤った）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? Number(argv[i + 1]) : d }
const DRAWS = flag('draws', 20)
const FUKU = argv.includes('--fuku')
const oc = FUKU ? 'fukusho_lo' : 'tansho'
const KIND = FUKU ? 'fukusho' : 'tansho'

// ---------- ズレの分布を作る（確定オッズの帯ごと） ----------
// live = final / ratio になるよう、ratio = final/live の実測値を貯める。
const BAND = [0, 1.5, 2.2, 3.2, 5, 8, 12, 20, 35, 60, 9999]
const bin = (o) => { for (let i = 1; i < BAND.length; i++) if (o < BAND[i]) return i - 1; return BAND.length - 2 }
const FIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, ${oc} o FROM odds_tan WHERE ${oc} > 0`).iterate())
  FIN.set(r.race_id + '|' + r.lane, r.o)
const RATIO = [...Array(BAND.length - 1)].map(() => [])
{
  const seen = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ${oc} o, mins_before FROM odds_live
      WHERE ok = 1 AND ${oc} > 0 ORDER BY mins_before DESC`).iterate())
    seen.set(r.race_id + '|' + r.lane, r.o)
  for (const [k, live] of seen) {
    const fin = FIN.get(k); if (!(fin > 0)) continue
    RATIO[bin(fin)].push(fin / live)
  }
}
console.log(`ズレの分布（健全な締切前オッズだけ・${KIND}）`)
console.log('  確定オッズ帯      件数   中央値   下位10%   上位10%')
for (let i = 0; i < RATIO.length; i++) {
  const v = RATIO[i]; if (v.length < 30) continue
  v.sort((a, b) => a - b)
  const q = (p) => v[Math.floor(v.length * p)]
  console.log(`  ${String(BAND[i]).padStart(4)}〜${BAND[i + 1] > 9000 ? '   ' : String(BAND[i + 1]).padStart(4)}倍 ${String(v.length).padStart(7)} ` +
    `${q(0.5).toFixed(3).padStart(8)} ${q(0.1).toFixed(3).padStart(9)} ${q(0.9).toFixed(3).padStart(9)}`)
}
const total = RATIO.reduce((a, b) => a + b.length, 0)
console.log(`  合計 ${total.toLocaleString()}件から作成\n`)
if (total < 1000) { console.log('分布を作るには足りない'); db.close(); process.exit(1) }

// ---------- 過去のレース（歩進検証） ----------
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type=? AND amount IS NOT NULL`).iterate(KIND))
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane FROM entries
    WHERE rank_num BETWEEN 1 AND ${FUKU ? 2 : 1}`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = new Set(); WIN.set(r.race_id, a) }
  a.add(r.lane)
}
const CAL = loadCalib(db, 'wi1')
// ⚠ 複勝の2着以内の確率は wi1 に無い（wi1 は1着の確率）。複勝は単勝のモデルでは測れない。
if (FUKU) { console.log('複勝は歩進検証に2着以内の確率が無いので、この方法では過去に遡れない'); db.close(); process.exit(0) }
const rows = []
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).iterate()) {
  const fin = FIN.get(r.race_id + '|' + r.lane); if (!(fin > 0)) continue
  if (!WIN.has(r.race_id)) continue
  rows.push({ id: r.race_id, lane: r.lane, p: r.p, fin, y: r.y, mo: r.month, b: bin(fin) })
}
const DAYS = new Set(rows.map((r) => r.id.slice(0, 8))).size
console.log(`過去のレース ${rows.length.toLocaleString()}本 / ${DAYS}日\n`)

// ★レース単位にまとめる。
//   艇ごとに独立に乱数を振ると「オッズ板の Σ(1/オッズ) は控除率で決まる」という
//   制約が壊れ、ありえない板が生まれて買い目が増えすぎる（最初それで1日111本・回収121%と出た。
//   実測は1日37本・回収87.1%だった）。板ごとに作って、合計を確定の板に合わせる。
const RACE = new Map()
for (const r of rows) { let a = RACE.get(r.id); if (!a) { a = []; RACE.set(r.id, a) } a.push(r) }

// ---------- 判定 ----------
function evaluate(liveOfRace) {
  let n = 0, hit = 0, ret = 0
  const per = new Map()
  for (const [, boats] of RACE) {
    const live = liveOfRace(boats)
    for (let i = 0; i < boats.length; i++) {
      const r = boats[i], o = live[i]
      if (!(o > 0)) continue
      const p = calibrate(CAL, r.p, o)
      if (o < (1 / p) * S.MARGIN) continue
      n++
      // ★払戻は必ず確定。判定だけを締切前の値で行う。
      const g = r.y === 1 ? (PAY.get(r.id + '|' + r.lane) ?? r.fin * 100) : 0
      if (r.y === 1) hit++
      ret += g
      let a = per.get(r.mo); if (!a) { a = { n: 0, g: 0 }; per.set(r.mo, a) }
      a.n++; a.g += g
    }
  }
  return { bets: n, hitRate: n ? hit / n * 100 : 0, roi: n ? ret / (n * 100) * 100 : 0,
    posMonths: [...per.values()].filter((a) => a.g > a.n * 100).length, months: per.size }
}
const base = evaluate((boats) => boats.map((r) => r.fin))
console.log('【確定オッズで判定（これまで根拠にしていた数字・実行不能）】')
console.log(`  ${base.bets.toLocaleString()}本  的中${base.hitRate.toFixed(2)}%  回収${base.roi.toFixed(1)}%  プラスの月 ${base.posMonths}/${base.months}\n`)

// 乱数は再現できるよう自前で（Math.random は使わない）
const FLAT = RATIO.flat()
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
console.log(`【締切前オッズをシミュレーションして判定】${DRAWS}回`)
console.log('  回   本数   1日   的中率   回収率  プラスの月')
const rois = []
for (let d = 0; d < DRAWS; d++) {
  const e = evaluate((boats) => {
    // ① 艇ごとにズレを引いて、締切前の見え方を作る
    const raw = boats.map((r) => {
      const v = RATIO[r.b].length ? RATIO[r.b] : FLAT
      const ratio = v[Math.floor(rnd() * v.length)]
      return ratio > 0 ? r.fin / ratio : r.fin        // live = 確定 ÷ ズレ
    })
    // ② 板として成立させる。Σ(1/オッズ) を確定の板に合わせる（控除率は締切前も同じ）
    const sf = boats.reduce((a, r) => a + 1 / r.fin, 0)
    const sr = raw.reduce((a, o) => a + 1 / o, 0)
    if (!(sr > 0)) return raw
    const k = sr / sf
    return raw.map((o) => o * k)
  })
  rois.push(e.roi)
  if (d < 8 || d === DRAWS - 1)
    console.log(`  ${String(d + 1).padStart(2)} ${String(e.bets).padStart(6)} ${(e.bets / DAYS).toFixed(1).padStart(6)} ` +
      `${e.hitRate.toFixed(2).padStart(7)}% ${e.roi.toFixed(1).padStart(7)}% ${e.posMonths}/${e.months}`)
}
rois.sort((a, b) => a - b)
console.log(`\n  ${DRAWS}回の回収率  中央値 ${rois[Math.floor(rois.length / 2)].toFixed(1)}%  ` +
  `最小 ${rois[0].toFixed(1)}%  最大 ${rois[rois.length - 1].toFixed(1)}%  100%超え ${rois.filter((x) => x >= 100).length}/${DRAWS}回`)
console.log('\n  ⚠ これは実測ではない。再現しているのは「表示のブレ」だけで、')
console.log('    締切間際の金が展示を見た人の金だとしたら現実はもっと悪い。')
console.log('    ここで100%を割るなら現実も割る。超えても現実が超えるとは限らない。')
db.close()
