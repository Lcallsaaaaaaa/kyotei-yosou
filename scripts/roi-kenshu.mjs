// モデルの本命の確率で絞ったうえで、単勝・2連単・3連単を買ったときの回収率。
//   node --max-old-space-size=6144 scripts/roi-kenshu.mjs --t1 wi1 --t3 wi3
//
// ★選ぶのはモデルの確率だけ。オッズは見ない。払い戻しは実際の配当。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'wi1'), T3 = flag('t3', 'wi3')

// 配当（100円あたり）
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
    WHERE bet_type IN ('tansho','nirentan','sanrentan','nirenpuku','sanrenpuku')`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)

// モデルの1着確率
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM ${T1}`).iterate()) {
  let m = P1.get(r.race_id); if (!m) { m = []; P1.set(r.race_id, m) }
  m.push(r)
}
const top1 = new Map()
for (const [rid, a] of P1) { a.sort((x, y) => y.p - x.p); top1.set(rid, { p: a[0].p, lane: a[0].lane }) }

// 3連単確率からそれぞれの本命を作る
const rs = []
let cur = null, rows = []
const flush = () => {
  if (!cur) return
  const t = top1.get(cur)
  if (t && rows.length) {
    const m2 = new Map(), m3 = new Map(), mf2 = new Map(), mf3 = new Map()
    for (const r of rows) {
      const q = r.combo.split('-')
      m3.set(r.combo, (m3.get(r.combo) ?? 0) + r.p)
      const k2 = q[0] + '-' + q[1]; m2.set(k2, (m2.get(k2) ?? 0) + r.p)
      const f2 = [q[0], q[1]].sort().join('-'); mf2.set(f2, (mf2.get(f2) ?? 0) + r.p)
      const f3 = [q[0], q[1], q[2]].sort().join('-'); mf3.set(f3, (mf3.get(f3) ?? 0) + r.p)
    }
    const top = (m) => [...m].sort((a, b) => b[1] - a[1])
    rs.push({ rid: cur, p: t.p, lane: t.lane,
      s2: top(m2).map((x) => x[0]), s3: top(m3).map((x) => x[0]),
      f2: top(mf2).map((x) => x[0]), f3: top(mf3).map((x) => x[0]) })
  }
  rows = []
}
for (const r of db.prepare(`SELECT race_id, combo, p FROM ${T3} ORDER BY race_id`).iterate()) {
  if (r.race_id !== cur) { flush(); cur = r.race_id }
  rows.push(r)
}
flush()
console.log(`${rs.length.toLocaleString()}レース\n`)

const run = (s, kind, key, pts) => {
  let n = 0, hit = 0, ret = 0
  for (const r of s) {
    const cs = r[key].slice(0, pts)
    if (!cs.length) continue
    n++
    for (const c of cs) {
      const a = PAY.get(r.rid + '|' + kind + '|' + c)
      if (a != null) { hit++; ret += a }
    }
  }
  if (!n) return null
  const cost = n * pts * 100
  return { n, hit, hr: hit / n * 100, roi: ret / cost * 100, avg: hit ? ret / hit : 0, pl: (ret - cost) / n }
}
const line = (lab, r, pts) => {
  if (!r) return
  console.log(`  ${lab.padEnd(16)} ${String(r.n).padStart(7)}レース ${String(pts).padStart(2)}点 的中${r.hr.toFixed(2).padStart(6)}% 平均払戻${r.avg.toFixed(0).padStart(6)}円 回収${r.roi.toFixed(2).padStart(7)}% 1レース${r.pl.toFixed(0).padStart(6)}円`)
}
for (const [lab, filt] of [['全レース', () => true], ['確率0.8以上', (r) => r.p >= 0.8]]) {
  const s = rs.filter(filt)
  console.log(`━━ ${lab}（${s.length.toLocaleString()}レース・1日${(s.length / 303).toFixed(1)}本）━━`)
  // 単勝は本命の枠
  {
    let n = 0, hit = 0, ret = 0
    for (const r of s) { n++; const a = PAY.get(r.rid + '|tansho|' + r.lane); if (a != null) { hit++; ret += a } }
    console.log(`  ${'単勝'.padEnd(16)} ${String(n).padStart(7)}レース  1点 的中${(hit / n * 100).toFixed(2).padStart(6)}% 平均払戻${(ret / hit).toFixed(0).padStart(6)}円 回収${(ret / (n * 100) * 100).toFixed(2).padStart(7)}% 1レース${((ret - n * 100) / n).toFixed(0).padStart(6)}円`)
  }
  for (const pts of [1, 2, 3, 4, 6]) line('2連単', run(s, 'nirentan', 's2', pts), pts)
  for (const pts of [1, 2, 3]) line('2連複', run(s, 'nirenpuku', 'f2', pts), pts)
  for (const pts of [1, 2, 4, 6, 12]) line('3連単', run(s, 'sanrentan', 's3', pts), pts)
  for (const pts of [1, 2, 4]) line('3連複', run(s, 'sanrenpuku', 'f3', pts), pts)
  console.log('')
}
db.close()
