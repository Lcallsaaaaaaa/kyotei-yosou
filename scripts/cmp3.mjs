// 複数モデルの的中率カーブを、共通のレースだけで並べる。
//   node --max-old-space-size=5120 scripts/cmp3.mjs --t wk3,wd3,we3,wf3 --names 旧モデル,案D枠別,案D＋展示,共通＋差分
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const TS = flag('t', 'wk3,wf3').split(',')
const NS = (flag('names', TS.join(','))).split(',')

// 共通レース
db.exec('DROP TABLE IF EXISTS tmp_c')
const where = TS.slice(1).map((t) => `race_id IN (SELECT race_id FROM ${t})`).join(" AND ")
const sql = `CREATE TEMP TABLE tmp_c AS SELECT DISTINCT race_id rid FROM ${TS[0]}` + (where ? ` WHERE ${where}` : "")
db.exec(sql)
const NC = db.prepare('SELECT COUNT(*) c FROM tmp_c').get().c
console.log(`共通レース ${NC.toLocaleString()}\n`)

const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
const MAXPT = 12
function curves(T) {
  const h1 = new Array(MAXPT).fill(0), h2 = new Array(MAXPT).fill(0), h3 = new Array(MAXPT).fill(0)
  let n = 0, cur = null, rows = []
  const flush = () => {
    if (!cur) return
    const o = ORD.get(cur)
    if (o && o[1] && o[2] && o[3]) {
      n++
      const t1 = `${o[1]}`, t2 = `${o[1]}-${o[2]}`, t3 = `${o[1]}-${o[2]}-${o[3]}`
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
    rows = []
  }
  for (const r of db.prepare(`SELECT t.race_id, t.combo, t.p FROM ${T} t JOIN tmp_c c ON c.rid=t.race_id ORDER BY t.race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    rows.push(r)
  }
  flush()
  return { n, h1, h2, h3 }
}
const R = TS.map(curves)
const PTS = [0, 1, 2, 3, 5, 7, 11]
for (const [name, key] of [['1着', 'h1'], ['2連単', 'h2'], ['3連単', 'h3']]) {
  console.log(`════ ${name} ════`)
  console.log('  点数 ' + NS.map((s) => s.padStart(11)).join(''))
  for (const k of PTS) {
    const vs = R.map((r) => r[key][k] / r.n * 100)
    if (vs.every((v) => v >= 99.99)) continue
    console.log(`  ${String(k + 1).padStart(3)}点 ` + vs.map((v) => (v.toFixed(2) + '%').padStart(11)).join(''))
  }
  console.log('')
}
db.close()
