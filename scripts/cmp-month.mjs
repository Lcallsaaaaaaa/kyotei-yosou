import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const A = flag('a', 'fs3'), B = flag('b', 'fw3w'), PT = Number(flag('pt', 6))
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
function per(T) {
  // レース単位で流し込む（全部ためると足りない）
  const out = new Map()
  let cur = null, rows = [], mo = null
  const flush = () => {
    if (!cur) return
    const o = ORD.get(cur)
    if (o && o[1] && o[2] && o[3]) {
      let s = out.get(mo); if (!s) { s = { n: 0, h1: 0, h2: 0 }; out.set(mo, s) }
      s.n++
      const m2 = new Map(), m1 = new Map()
      for (const r of rows) { const q = r.combo.split(String.fromCharCode(45))
        m2.set(q[0]+String.fromCharCode(45)+q[1], (m2.get(q[0]+String.fromCharCode(45)+q[1]) ?? 0) + r.p)
        m1.set(q[0], (m1.get(q[0]) ?? 0) + r.p) }
      const s1 = [...m1].sort((x,y)=>y[1]-x[1]), s2 = [...m2].sort((x,y)=>y[1]-x[1])
      if (s1[0][0] === String(o[1])) s.h1++
      if (s2.slice(0, PT).some(([c]) => c === o[1]+String.fromCharCode(45)+o[2])) s.h2++
    }
    rows = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, p, month FROM ${T} ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id; mo = r.month }
    rows.push(r)
  }
  flush()
  return out
}
function _old(T) {
  const R = new Map(), MO = new Map()
  for (const r of db.prepare(`SELECT race_id, combo, p, month FROM ${T}`).iterate()) {
    let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a); MO.set(r.race_id, r.month) }
    a.push(r)
  }
  const out = new Map()
  for (const [rid, rows] of R) {
    const o = ORD.get(rid); if (!o || !o[1] || !o[2] || !o[3]) continue
    const mo = MO.get(rid)
    let s = out.get(mo); if (!s) { s = { n: 0, h1: 0, h2: 0 }; out.set(mo, s) }
    s.n++
    const m2 = new Map(), m1 = new Map()
    for (const r of rows) { const q = r.combo.split('-')
      m2.set(q[0]+'-'+q[1], (m2.get(q[0]+'-'+q[1]) ?? 0) + r.p)
      m1.set(q[0], (m1.get(q[0]) ?? 0) + r.p) }
    const s1 = [...m1].sort((x,y)=>y[1]-x[1]), s2 = [...m2].sort((x,y)=>y[1]-x[1])
    if (s1[0][0] === `${o[1]}`) s.h1++
    if (s2.slice(0, PT).some(([c]) => c === `${o[1]}-${o[2]}`)) s.h2++
  }
  return out
}
const a = per(A), b = per(B)
console.log(`\n月       レース  1着1点(順)  1着1点(全体)   差    2連単${PT}点(順) 2連単${PT}点(全体)   差`)
let wa1=0, wb1=0, wa2=0, wb2=0, wn=0
for (const mo of [...a.keys()].sort()) {
  const x = a.get(mo), y = b.get(mo); if (!y) continue
  wn += x.n; wa1 += x.h1; wb1 += y.h1; wa2 += x.h2; wb2 += y.h2
  const p = (h, n) => (h/n*100).toFixed(2).padStart(6)+'%'
  const d1 = (y.h1/y.n - x.h1/x.n)*100, d2 = (y.h2/y.n - x.h2/x.n)*100
  console.log(`${mo} ${String(x.n).padStart(7)} ${p(x.h1,x.n).padStart(11)} ${p(y.h1,y.n).padStart(13)} ${((d1>=0?'+':'')+d1.toFixed(2)+'pt').padStart(9)} ${p(x.h2,x.n).padStart(12)} ${p(y.h2,y.n).padStart(14)} ${((d2>=0?'+':'')+d2.toFixed(2)+'pt').padStart(9)}`)
}
console.log(`合計 ${String(wn).padStart(7)} ${(wa1/wn*100).toFixed(2).padStart(10)}% ${(wb1/wn*100).toFixed(2).padStart(12)}% ${(((wb1-wa1)/wn*100)>=0?'+':'')+((wb1-wa1)/wn*100).toFixed(2)+'pt'} ${(wa2/wn*100).toFixed(2).padStart(11)}% ${(wb2/wn*100).toFixed(2).padStart(13)}% ${(((wb2-wa2)/wn*100)>=0?'+':'')+((wb2-wa2)/wn*100).toFixed(2)+'pt'}`)
db.close()
