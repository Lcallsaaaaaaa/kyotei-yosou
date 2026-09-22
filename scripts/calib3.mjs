// 校正をさらに詰める。あわせて配当の計算が正しいかを毎回検算する。
//
//   node --max-old-space-size=6144 scripts/calib3.mjs --t wi1
//
// ★検算（毎回やる）
//   回収率を2通りの方法で出して一致するか確かめる。
//     A: odds_tan の確定オッズ × 100
//     B: payouts テーブルの実際の払戻金
//   ずれたら計算か対応づけが間違っている。
//
// ★校正の升目
//   前回は「確率帯 × モデル÷市場」の2次元。まだ1.85pt自信過剰が残った。
//   オッズ帯を3次元目に足す。買い目の性格（本命か穴か）で自信過剰の量が違うため。
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
// 実際の払戻（検算用）
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
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
    rows.push({ rid, mo: bs[i].month, lane: bs[i].lane, p: bs[i].p, q: q[i], od,
      hit: bs[i].y === 1, pay: PAY.get(rid + '|' + bs[i].lane) ?? null })
  }
}
const MOS = [...new Set(rows.map((r) => r.mo))].filter(Boolean).sort()
console.log(`${rows.length.toLocaleString()}件（${MOS.length}ヶ月）\n`)

// ---------- 検算：オッズ×100 と 実際の払戻が一致するか ----------
{
  const w = rows.filter((r) => r.hit && r.pay != null)
  const ok = w.filter((r) => Math.abs(r.od * 100 - r.pay) / r.pay < 0.02).length
  console.log('■ 配当の検算')
  console.log(`  当たった買い目 ${w.length.toLocaleString()}件　オッズ×100 と 実際の払戻が2%以内で一致 ${(ok / w.length * 100).toFixed(2)}%`)
  const bad = w.filter((r) => Math.abs(r.od * 100 - r.pay) / r.pay >= 0.02)
  if (bad.length) {
    const d = bad.map((r) => (r.od * 100 - r.pay) / r.pay)
    console.log(`  ずれ ${bad.length}件　中央 ${(d.sort((a, b) => a - b)[Math.floor(d.length / 2)] * 100).toFixed(1)}%　例 ${bad.slice(0, 3).map((r) => `${r.rid} ${r.lane}号艇 ${r.od}倍→${r.pay}円`).join(' / ')}`)
  }
}

const PB = [0, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
const RB = [0, 0.5, 0.7, 0.85, 1.0, 1.15, 1.35, 1.6, 2.0, 2.8, 99]
const OB = [0, 1.5, 2.2, 3.2, 5, 8, 15, 30, 9999]
const bi = (B, v) => { for (let i = 1; i < B.length; i++) if (v < B[i]) return i - 1; return B.length - 2 }
function makeCal(train, dims, K) {
  const key = (r) => dims.map((d) => d(r)).join('|')
  const M = new Map()
  for (const r of train) {
    const k = key(r)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.hit ? 1 : 0; a.sp += r.p
  }
  const cal = new Map()
  for (const [k, a] of M) {
    const obs = a.h / a.n, said = a.sp / a.n
    const w = a.n / (a.n + K)
    cal.set(k, (w * obs + (1 - w) * said) / Math.max(said, 1e-9))
  }
  return { cal, key }
}
const DIMS = {
  '確率×市場比（前回）': { d: [(r) => bi(PB, r.p), (r) => bi(RB, r.p / r.q)], K: 300 },
  '確率×市場比×オッズ': { d: [(r) => bi(PB, r.p), (r) => bi(RB, r.p / r.q), (r) => bi(OB, r.od)], K: 300 },
  '確率×市場比×オッズ K=800': { d: [(r) => bi(PB, r.p), (r) => bi(RB, r.p / r.q), (r) => bi(OB, r.od)], K: 800 },
  '確率×オッズ': { d: [(r) => bi(PB, r.p), (r) => bi(OB, r.od)], K: 300 },
}
const ev = (arr, getP, m) => {
  const s = arr.filter((r) => r.od >= (1 / getP(r)) * m)
  if (s.length < 50) return null
  const h = s.filter((r) => r.hit)
  const retA = h.reduce((a, r) => a + r.od * 100, 0)                       // オッズ×100
  const retB = h.reduce((a, r) => a + (r.pay ?? r.od * 100), 0)            // 実際の払戻
  const days = new Set(arr.map((r) => r.rid)).size / 149.6
  const per = [...new Set(s.map((r) => r.mo))].sort().map((mo) => {
    const t = s.filter((r) => r.mo === mo)
    if (t.length < 30) return null
    return t.filter((x) => x.hit).reduce((a, x) => a + (x.pay ?? x.od * 100), 0) / (t.length * 100) * 100
  }).filter((x) => x != null)
  const said = s.reduce((a, r) => a + getP(r), 0) / s.length * 100
  const act = h.length / s.length * 100
  return { n: s.length, perDay: s.length / days, hr: act, said, gap: act - said,
    roiA: retA / (s.length * 100) * 100, roiB: retB / (s.length * 100) * 100,
    avg: h.length ? retB / h.length : 0,
    pl: (retB - s.length * 100) / days, plus: per.filter((x) => x >= 100).length, months: per.length,
    min: per.length ? Math.min(...per) : 0, per }
}
const show = (lab, x) => {
  if (!x) return
  console.log(`  ${lab.padEnd(20)} ${String(x.n).padStart(6)}件 ${x.perDay.toFixed(1).padStart(6)}本/日 **的中${x.hr.toFixed(2).padStart(6)}%** 平均払戻${x.avg.toFixed(0).padStart(5)}円 回収${x.roiB.toFixed(2).padStart(7)}%(検算${x.roiA.toFixed(2)}%) 校正ずれ${x.gap.toFixed(2).padStart(6)}pt 1日${x.pl.toFixed(0).padStart(6)}円 ${x.plus}/${x.months}ヶ月`)
}
console.log('\n■ 引き直しなし')
for (const m of [1.0, 1.3, 1.5]) show(`余裕${m.toFixed(1)}`, ev(rows.filter((r) => r.mo > MOS[0]), (r) => r.p, m))
for (const [nm, cfg] of Object.entries(DIMS)) {
  const out = []
  for (let i = 1; i < MOS.length; i++) {
    const mo = MOS[i]
    const train = rows.filter((r) => r.mo < mo)
    if (train.length < 20000) continue
    const { cal, key } = makeCal(train, cfg.d, cfg.K)
    for (const r of rows.filter((r) => r.mo === mo)) {
      const c = cal.get(key(r))
      out.push({ ...r, pc: c ? Math.min(0.999, Math.max(1e-6, r.p * c)) : r.p })
    }
  }
  console.log(`\n■ ${nm}`)
  for (const m of [1.0, 1.2, 1.3, 1.5, 1.8]) show(`余裕${m.toFixed(1)}`, ev(out, (r) => r.pc, m))
}
db.close()
