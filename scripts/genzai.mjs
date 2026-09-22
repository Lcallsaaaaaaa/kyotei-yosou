// いまのモデルの、全券種の成績を一覧にする。
//   node --max-old-space-size=6144 scripts/genzai.mjs
//
// 選ぶのはモデルの確率だけ。払戻は実際の配当。45,340レース・2025-11〜2026-08。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts WHERE amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho, fukusho_lo FROM odds_tan`).iterate())
  OD.set(r.race_id + '|' + r.lane, r)
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1`).iterate()) {
  let a = P1.get(r.race_id); if (!a) { a = []; P1.set(r.race_id, a) }
  a.push(r)
}
for (const [, a] of P1) a.sort((x, y) => y.p - x.p)

const rs = []
let cur = null, rows = []
const flush = () => {
  if (!cur) return
  const t = P1.get(cur)
  if (t && rows.length) {
    const m2 = new Map(), m3 = new Map(), f2 = new Map(), f3 = new Map()
    for (const r of rows) {
      const q = r.combo.split('-')
      m3.set(r.combo, (m3.get(r.combo) ?? 0) + r.p)
      const k = q[0] + '-' + q[1]; m2.set(k, (m2.get(k) ?? 0) + r.p)
      const a = [q[0], q[1]].sort().join('-'); f2.set(a, (f2.get(a) ?? 0) + r.p)
      const b = [q[0], q[1], q[2]].sort().join('-'); f3.set(b, (f3.get(b) ?? 0) + r.p)
    }
    const srt = (m) => [...m].sort((a, b) => b[1] - a[1]).map((x) => x[0])
    rs.push({ rid: cur, p: t[0].p, lane: t[0].lane,
      tan: t.map((x) => String(x.lane)), fuku: t.map((x) => String(x.lane)),
      n2t: srt(m2), n2f: srt(f2), s3t: rows.slice().sort((a, b) => b.p - a.p).map((r) => r.combo), s3f: srt(f3) })
  }
  rows = []
}
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()) {
  if (r.race_id !== cur) { flush(); cur = r.race_id }
  rows.push(r)
}
flush()
const N = rs.length
console.log(`いまのモデル（線形・46項目）　${N.toLocaleString()}レース　2025-11〜2026-08\n`)
const ev = (kind, key, pts) => {
  let hit = 0, ret = 0
  for (const r of rs) for (const c of r[key].slice(0, pts)) {
    const a = PAY.get(r.rid + '|' + kind + '|' + c); if (a != null) { hit++; ret += a }
  }
  const cost = N * pts * 100
  return { hr: hit / N * 100, roi: ret / cost * 100, avg: hit ? ret / hit : 0, pl: (ret - cost) / N }
}
const KIND = [['単勝', 'tansho', 'tan', [1, 2, 3]], ['複勝', 'fukusho', 'fuku', [1, 2, 3]],
  ['2連複', 'nirenpuku', 'n2f', [1, 2, 3, 4, 6]], ['2連単', 'nirentan', 'n2t', [1, 2, 3, 4, 6, 8]],
  ['3連複', 'sanrenpuku', 's3f', [1, 2, 3, 4, 6]], ['3連単', 'sanrentan', 's3t', [1, 2, 3, 4, 6, 12]]]
console.log('券種    点数   的中率   平均払戻    回収率   1レース損益   1日100円買いの損益')
for (const [nm, kind, key, ptsList] of KIND) {
  for (const pts of ptsList) {
    const x = ev(kind, key, pts)
    console.log(`${nm.padEnd(6)} ${String(pts).padStart(3)}点 ${x.hr.toFixed(2).padStart(7)}% ${x.avg.toFixed(0).padStart(8)}円 ${x.roi.toFixed(2).padStart(8)}% ${x.pl.toFixed(0).padStart(9)}円 ${(x.pl * 149.6).toFixed(0).padStart(14)}円`)
  }
  console.log('')
}
// 単勝の必要倍率
console.log('単勝を「必要倍率＝(1÷確率)×余裕」で絞った場合')
console.log('  余裕   買う数   1日     的中率  平均払戻   回収率  1日100円買いの損益')
for (const m of [1.0, 1.2, 1.3, 1.5, 1.8]) {
  const s = rs.filter((r) => { const o = OD.get(r.rid + '|' + r.lane); return o?.tansho > 0 && o.tansho >= (1 / r.p) * m })
  if (s.length < 100) continue
  let hit = 0, ret = 0
  for (const r of s) { const a = PAY.get(r.rid + '|tansho|' + r.lane); if (a != null) { hit++; ret += a } }
  const roi = ret / (s.length * 100) * 100
  const pl = (ret - s.length * 100) / s.length
  console.log(`  ${m.toFixed(1)}  ${String(s.length).padStart(7)} ${(s.length / 303).toFixed(1).padStart(6)}本 ${(hit / s.length * 100).toFixed(2).padStart(7)}% ${(hit ? ret / hit : 0).toFixed(0).padStart(7)}円 ${roi.toFixed(2).padStart(8)}% ${(pl * s.length / 303).toFixed(0).padStart(14)}円`)
}
db.close()
