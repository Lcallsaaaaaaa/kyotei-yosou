// 単勝の判定を作り直す。①校正 ②市場とのズレによる割引 ③全6艇を対象。
//
//   node --max-old-space-size=6144 scripts/calib2.mjs --t wi1
//
// ★分かっていること（edge.mjs の測定）
//   ・モデルは全確率帯で自信過剰。0.8と言って実際71.55%（−9.09pt）
//   ・モデルが市場より高く見ている艇ほど自信過剰（ズレ2.0倍以上で +3.67pt）
//   ・逆にモデルが低く見ている艇では市場のほうが過大（+5.64pt）
//   ・必要倍率は本命1艇に限る理由がない。全6艇に当てると買い目が5.7倍
//
// ★直し方
//   確率を「確率帯 × モデル÷市場の比」の升目ごとに、実際の的中率へ引き直す。
//   引き直しは**学習期間だけ**で作り、検証期間には触らせない（時点を守る）。
//   引き直した確率で必要倍率を計算し直す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wi1')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const mkt = (o) => {
  const r = [1, 2, 3, 4, 5, 6].map((l) => (o[l] > 0 ? 1 / o[l] : 0))
  const s = r.reduce((a, b) => a + b, 0)
  return r.map((v) => v / s)
}
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM ${T}`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rows = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = OD.get(rid); if (!o) continue
  bs.sort((a, b) => a.lane - b.lane)
  const q = mkt(o)
  for (let i = 0; i < 6; i++) {
    const od = o[bs[i].lane]
    if (!(od > 0) || !(q[i] > 0)) continue
    rows.push({ rid, mo: bs[i].month, p: bs[i].p, q: q[i], od, hit: bs[i].y === 1 })
  }
}
const MOS = [...new Set(rows.map((r) => r.mo))].filter(Boolean).sort()
console.log(`${rows.length.toLocaleString()}件（${MOS.length}ヶ月・${MOS[0]}〜${MOS[MOS.length - 1]}）\n`)

// 升目の切り方
const PB = [0, 0.03, 0.07, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 1.01]
const RB = [0, 0.6, 0.8, 1.0, 1.25, 1.6, 2.2, 99]
const pi = (p) => { for (let i = 1; i < PB.length; i++) if (p < PB[i]) return i - 1; return PB.length - 2 }
const ri = (x) => { for (let i = 1; i < RB.length; i++) if (x < RB[i]) return i - 1; return RB.length - 2 }
/** 学習期間から引き直し表を作る（縮小推定つき：件数が少ない升目は元の値に寄せる） */
function makeCal(train, K = 300) {
  const M = new Map()
  for (const r of train) {
    const k = pi(r.p) + '|' + ri(r.p / r.q)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.hit ? 1 : 0; a.sp += r.p
  }
  const cal = new Map()
  for (const [k, a] of M) {
    const obs = a.h / a.n            // 実際の的中率
    const said = a.sp / a.n          // モデルが言った平均
    const w = a.n / (a.n + K)        // 件数が少ないほど元の値に寄せる
    cal.set(k, { ratio: (w * obs + (1 - w) * said) / Math.max(said, 1e-9), n: a.n })
  }
  return cal
}
const applyCal = (cal, r) => {
  const c = cal.get(pi(r.p) + '|' + ri(r.p / r.q))
  return c ? Math.min(0.999, Math.max(1e-6, r.p * c.ratio)) : r.p
}

// 歩進：その月より前だけで引き直し表を作り、その月に当てる
const out = []
for (let i = 1; i < MOS.length; i++) {
  const mo = MOS[i]
  const train = rows.filter((r) => r.mo < mo)
  if (train.length < 20000) continue
  const cal = makeCal(train)
  for (const r of rows.filter((r) => r.mo === mo)) out.push({ ...r, pc: applyCal(cal, r) })
}
console.log(`引き直しを当てた ${out.length.toLocaleString()}件（${[...new Set(out.map((r) => r.mo))].length}ヶ月）\n`)

const ev = (arr, getP, m) => {
  const s = arr.filter((r) => r.od >= (1 / getP(r)) * m)
  if (s.length < 50) return null
  const hitN = s.filter((r) => r.hit).length
  const ret = s.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0)
  const days = new Set(arr.map((r) => r.rid)).size / 149.6
  const per = [...new Set(s.map((r) => r.mo))].sort().map((mo) => {
    const t = s.filter((r) => r.mo === mo)
    if (t.length < 30) return null
    return t.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0) / (t.length * 100) * 100
  }).filter((x) => x != null)
  return { n: s.length, perDay: s.length / days, hr: hitN / s.length * 100,
    roi: ret / (s.length * 100) * 100, pl: (ret - s.length * 100) / days,
    plus: per.filter((x) => x >= 100).length, months: per.length,
    min: per.length ? Math.min(...per) : 0, per }
}
const show = (lab, x) => {
  if (!x) return
  console.log(`  ${lab.padEnd(24)} ${String(x.n).padStart(7)}件 ${x.perDay.toFixed(1).padStart(6)}本/日 的中${x.hr.toFixed(2).padStart(6)}% 回収${x.roi.toFixed(2).padStart(7)}% 1日${x.pl.toFixed(0).padStart(6)}円 ${x.plus}/${x.months}ヶ月 最低${x.min.toFixed(0)}%`)
}
console.log('■ 引き直しなし（いまのやり方・全6艇）')
for (const m of [1.0, 1.2, 1.3, 1.5, 1.8]) show(`余裕${m.toFixed(1)}`, ev(out, (r) => r.p, m))
console.log('\n■ 引き直しあり（確率帯 × モデル÷市場 の升目で校正）')
for (const m of [1.0, 1.2, 1.3, 1.5, 1.8]) show(`余裕${m.toFixed(1)}`, ev(out, (r) => r.pc, m))
console.log('\n■ 引き直し後の校正の確認（余裕1.3で選ばれた買い目）')
{
  const s = out.filter((r) => r.od >= (1 / r.pc) * 1.3)
  const said = s.reduce((a, r) => a + r.pc, 0) / s.length * 100
  const act = s.filter((r) => r.hit).length / s.length * 100
  console.log(`  引き直し後に言った確率 ${said.toFixed(2)}%　実際 ${act.toFixed(2)}%　ずれ ${(act - said).toFixed(2)}pt`)
  const s0 = out.filter((r) => r.od >= (1 / r.p) * 1.3)
  const said0 = s0.reduce((a, r) => a + r.p, 0) / s0.length * 100
  const act0 = s0.filter((r) => r.hit).length / s0.length * 100
  console.log(`  引き直し前            ${said0.toFixed(2)}%　実際 ${act0.toFixed(2)}%　ずれ ${(act0 - said0).toFixed(2)}pt`)
}
const best = ev(out, (r) => r.pc, 1.3)
if (best) console.log(`\n  余裕1.3の月ごと: ${best.per.map((x) => x.toFixed(0) + '%').join(' ')}`)
db.close()
