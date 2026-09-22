// 1レースで複数の艇が条件を満たしたとき、どうするのが良いか。
//   node --max-old-space-size=6144 scripts/multi.mjs --t wi1
//
// ★選択肢
//   A 全部買う（検証してきた形）
//   B 確率が一番高い1艇だけ
//   C オッズが一番高い1艇だけ（配当を狙う）
//   D 余裕が一番大きい1艇だけ（市場とのズレが最大）
//   E 上位2艇まで
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
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM ${T}`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
// 校正（確率帯×オッズ帯・その月より前だけで作る）
const PB = [0, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
const OB = [0, 1.5, 2.2, 3.2, 5, 8, 15, 30, 9999]
const bi = (B, v) => { for (let i = 1; i < B.length; i++) if (v < B[i]) return i - 1; return B.length - 2 }
const all = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = OD.get(rid); if (!o) continue
  for (const b of bs) {
    const od = o[b.lane]
    if (!(od > 0)) continue
    all.push({ rid, mo: b.month, lane: b.lane, p: b.p, od, hit: b.y === 1,
      pay: PAY.get(rid + '|' + b.lane) ?? null })
  }
}
const MOS = [...new Set(all.map((r) => r.mo))].filter(Boolean).sort()
const rows = []
for (let i = 1; i < MOS.length; i++) {
  const mo = MOS[i]
  const train = all.filter((r) => r.mo < mo)
  if (train.length < 20000) continue
  const M = new Map()
  for (const r of train) {
    const k = bi(PB, r.p) + '|' + bi(OB, r.od)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.hit ? 1 : 0; a.sp += r.p
  }
  const cal = new Map()
  for (const [k, a] of M) {
    const w = a.n / (a.n + 300)
    cal.set(k, (w * (a.h / a.n) + (1 - w) * (a.sp / a.n)) / Math.max(a.sp / a.n, 1e-9))
  }
  for (const r of all.filter((r) => r.mo === mo)) {
    const c = cal.get(bi(PB, r.p) + '|' + bi(OB, r.od))
    rows.push({ ...r, pc: c ? Math.min(0.999, Math.max(1e-6, r.p * c)) : r.p })
  }
}
console.log(`${rows.length.toLocaleString()}件（${[...new Set(rows.map((r) => r.mo))].length}ヶ月）\n`)
const byRace = new Map()
for (const r of rows) { let a = byRace.get(r.rid); if (!a) { a = []; byRace.set(r.rid, a) } a.push(r) }
const days = byRace.size / 149.6

console.log('■ 1レースで何艇が条件を満たすか（余裕1.3）')
{
  const c = new Map()
  for (const [, bs] of byRace) {
    const n = bs.filter((b) => b.od >= (1 / b.pc) * 1.3).length
    c.set(n, (c.get(n) ?? 0) + 1)
  }
  for (const [n, v] of [...c].sort((a, b) => a[0] - b[0]))
    console.log(`  ${n}艇  ${String(v).padStart(6)}レース (${(v / byRace.size * 100).toFixed(1)}%)`)
}
const run = (margin, pick) => {
  let bets = 0, hit = 0, ret = 0
  const per = new Map()
  for (const [, bs] of byRace) {
    const ok = bs.filter((b) => b.od >= (1 / b.pc) * margin)
    if (!ok.length) continue
    for (const b of pick(ok)) {
      bets++
      const p = b.hit ? (b.pay ?? b.od * 100) : 0
      if (b.hit) hit++
      ret += p
      let a = per.get(b.mo); if (!a) { a = { b: 0, r: 0 }; per.set(b.mo, a) }
      a.b++; a.r += p
    }
  }
  if (bets < 100) return null
  const ms = [...per.values()].filter((a) => a.b >= 30)
  return { bets, perDay: bets / days, hr: hit / bets * 100, roi: ret / (bets * 100) * 100,
    avg: hit ? ret / hit : 0, pl: (ret - bets * 100) / days,
    plus: ms.filter((a) => a.r / (a.b * 100) >= 1).length, months: ms.length }
}
const PICKS = {
  'A 全部買う': (a) => a,
  'B 確率が一番高い1艇': (a) => [a.reduce((x, y) => (y.pc > x.pc ? y : x))],
  'C オッズが一番高い1艇': (a) => [a.reduce((x, y) => (y.od > x.od ? y : x))],
  'D 余裕が一番大きい1艇': (a) => [a.reduce((x, y) => (y.pc * y.od > x.pc * x.od ? y : x))],
  'E 確率上位2艇まで': (a) => [...a].sort((x, y) => y.pc - x.pc).slice(0, 2),
}
for (const m of [1.0, 1.3, 1.5]) {
  console.log(`\n■ 余裕${m.toFixed(1)}`)
  console.log('  買い方                買う数  1日   的中率  平均払戻   回収率  1日100円の損益  月ごと')
  for (const [nm, f] of Object.entries(PICKS)) {
    const x = run(m, f)
    if (!x) continue
    console.log(`  ${nm.padEnd(20)} ${String(x.bets).padStart(6)} ${x.perDay.toFixed(1).padStart(5)}本 ${x.hr.toFixed(2).padStart(6)}% ${x.avg.toFixed(0).padStart(7)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.pl.toFixed(0).padStart(12)}円 ${x.plus}/${x.months}ヶ月`)
  }
}
db.close()
