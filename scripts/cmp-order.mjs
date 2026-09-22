// 「1着を先に決める」方式と「着順パターン全体を評価する」方式を比べる。
//
//   node scripts/cmp-order.mjs --a sd3 --b sd3w
//
// ★何を比べるか
//   同じ学習・同じレースから出した2つの並べ方を、
//   1着 / 2連単 / 3連単 の的中率で突き合わせる。
//   買う点数を1点・2点・…と増やしたときの伸び方も出す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const A = flag('a', 'wd3'), B = flag('b', 'wd3w')

// 正解の並び
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}

function load(T) {
  const R = new Map()
  for (const r of db.prepare(`SELECT race_id, combo, p FROM ${T}`).iterate()) {
    let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
    a.push(r)
  }
  return R
}
function curves(R, label) {
  const MAXPT = 12
  const h1 = new Array(MAXPT).fill(0), h2 = new Array(MAXPT).fill(0), h3 = new Array(MAXPT).fill(0)
  let n = 0
  for (const [rid, rows] of R) {
    const o = ORD.get(rid); if (!o || !o[1] || !o[2] || !o[3]) continue
    n++
    const t1 = `${o[1]}`, t2 = `${o[1]}-${o[2]}`, t3 = `${o[1]}-${o[2]}-${o[3]}`
    // 3連単をそのまま / 2連単・1着は畳んで作り直す
    const s3 = rows.slice().sort((x, y) => y.p - x.p)
    const m2 = new Map(), m1 = new Map()
    for (const r of rows) {
      const q = r.combo.split('-')
      const k2 = q[0] + '-' + q[1]
      m2.set(k2, (m2.get(k2) ?? 0) + r.p)
      m1.set(q[0], (m1.get(q[0]) ?? 0) + r.p)
    }
    const s2 = [...m2].sort((x, y) => y[1] - x[1])
    const s1 = [...m1].sort((x, y) => y[1] - x[1])
    for (let k = 0; k < MAXPT; k++) {
      if (s1.slice(0, k + 1).some(([c]) => c === t1)) h1[k]++
      if (s2.slice(0, k + 1).some(([c]) => c === t2)) h2[k]++
      if (s3.slice(0, k + 1).some((r) => r.combo === t3)) h3[k]++
    }
  }
  return { label, n, h1, h2, h3 }
}

const ra = curves(load(A), A), rb = curves(load(B), B)
console.log(`\n対象レース ${ra.n.toLocaleString()}\n`)
const pct = (h, n) => (h / n * 100).toFixed(2).padStart(6) + '%'
const rows = [['1着', 'h1'], ['2連単', 'h2'], ['3連単', 'h3']]
for (const [name, key] of rows) {
  console.log(`════ ${name} ════`)
  console.log('  点数   1着を先に決める   パターン全体      差')
  for (const k of [0, 1, 2, 3, 5, 7, 11]) {
    const a = ra[key][k] / ra.n * 100, b = rb[key][k] / rb.n * 100
    const d = b - a
    console.log(`  ${String(k + 1).padStart(3)}点 ${pct(ra[key][k], ra.n).padStart(15)} ${pct(rb[key][k], rb.n).padStart(15)} ${(d >= 0 ? '+' : '') + d.toFixed(2)}pt`)
  }
  console.log('')
}
db.close()
