// 見張り表に出た艇のうち、実際にオッズが必要倍率に届くのは何割か。
//   node --max-old-space-size=6144 scripts/hit-rate-watch.mjs
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const PB = [0, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
const OB = [0, 1.5, 2.2, 3.2, 5, 8, 15, 30, 9999]
const bi = (B, v) => { for (let i = 1; i < B.length; i++) if (v < B[i]) return i - 1; return B.length - 2 }
const all = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = OD.get(rid); if (!o) continue
  for (const b of bs) { const od = o[b.lane]; if (od > 0) all.push({ rid, mo: b.month, p: b.p, od, hit: b.y === 1 }) }
}
const MOS = [...new Set(all.map((r) => r.mo))].filter(Boolean).sort()
// 校正表（全期間・簡易）
const M = new Map()
for (const r of all) {
  const k = bi(PB, r.p) + '|' + bi(OB, r.od)
  let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
  a.n++; a.h += r.hit ? 1 : 0; a.sp += r.p
}
const cal = new Map()
for (const [k, a] of M) { const w = a.n / (a.n + 300); cal.set(k, (w * (a.h / a.n) + (1 - w) * (a.sp / a.n)) / Math.max(a.sp / a.n, 1e-9)) }
/** 朝の必要倍率（見張り表と同じ解き方） */
const need = (pRaw, margin) => {
  for (let b = 0; b < OB.length - 1; b++) {
    const c = cal.get(bi(PB, pRaw) + '|' + b)
    const p = c ? Math.min(0.999, Math.max(1e-6, pRaw * c)) : pRaw
    const v = (1 / p) * margin
    if (v >= OB[b] && v < OB[b + 1]) return v
    if (v < OB[b]) return OB[b]
  }
  return null
}
const byRace = new Map()
for (const r of all) { let a = byRace.get(r.rid); if (!a) { a = []; byRace.set(r.rid, a) } a.push(r) }
console.log(`${byRace.size.toLocaleString()}レース\n`)
console.log('  余裕  見張る艇  1日   届いた艇  1日   届く割合  1レース見張り  1レース買い')
for (const m of [1.0, 1.3, 1.5]) {
  let watch = 0, buy = 0
  for (const [, bs] of byRace) for (const b of bs) {
    const n = need(b.p, m)
    if (n == null || n > 30) continue
    watch++
    if (b.od >= n) buy++
  }
  const days = byRace.size / 149.6
  console.log(`  ${m.toFixed(1)} ${String(watch).padStart(9)} ${(watch / days).toFixed(0).padStart(5)}本 ${String(buy).padStart(9)} ${(buy / days).toFixed(1).padStart(5)}本 ${(buy / watch * 100).toFixed(1).padStart(8)}% ${(watch / byRace.size).toFixed(2).padStart(13)}艇 ${(buy / byRace.size).toFixed(2).padStart(11)}艇`)
}
console.log('\n■ 見張り表に3艇出たレースで、実際に何艇買うか（余裕1.3）')
{
  const c = new Map()
  for (const [, bs] of byRace) {
    const w = bs.filter((b) => { const n = need(b.p, 1.3); return n != null && n <= 30 })
    if (w.length !== 3) continue
    const nb = w.filter((b) => b.od >= need(b.p, 1.3)).length
    c.set(nb, (c.get(nb) ?? 0) + 1)
  }
  const t = [...c.values()].reduce((a, b) => a + b, 0)
  for (const [n, v] of [...c].sort((a, b) => a[0] - b[0]))
    console.log(`  ${n}艇買う  ${String(v).padStart(6)}レース (${(v / t * 100).toFixed(1)}%)`)
}
db.close()
