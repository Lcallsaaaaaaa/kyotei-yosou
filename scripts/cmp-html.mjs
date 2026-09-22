// 「1着を先に決める」方式と「並び全体で比べる」方式を、的中率で突き合わせて表HTMLにする。
//   node --max-old-space-size=4096 scripts/cmp-html.mjs --a wd3 --b wd3w --out <path>
//
// ★レース単位で流し込む。全部ためるとメモリが足りない（実際に落ちた）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const A = flag('a', 'wd3'), B = flag('b', 'wd3w'), OUT = flag('out', null)
const SKIP = flag('skip', null)   // 除く月（カンマ区切り）
const skip = new Set(SKIP ? SKIP.split(',') : [])

const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
const MAXPT = 12
function curves(T) {
  const h1 = new Array(MAXPT).fill(0), h2 = new Array(MAXPT).fill(0), h3 = new Array(MAXPT).fill(0)
  let n = 0, cur = null, mo = null, rows = []
  const flush = () => {
    if (!cur) return
    const o = ORD.get(cur)
    if (o && o[1] && o[2] && o[3] && !skip.has(mo)) {
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
  for (const r of db.prepare(`SELECT race_id, combo, p, month FROM ${T} ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id; mo = r.month }
    rows.push(r)
  }
  flush()
  return { n, h1, h2, h3 }
}
const ra = curves(A), rb = curves(B)
const PTS = [0, 1, 2, 3, 5, 7, 11]
let html = `<table><thead><tr><th>買う点数</th><th>1着を先に決める</th><th>並び全体で比べる</th><th>差</th></tr></thead><tbody>`
for (const [name, key] of [['1着', 'h1'], ['2連単', 'h2'], ['3連単', 'h3']]) {
  html += `<tr><th colspan="4">${name}</th></tr>`
  for (const k of PTS) {
    const a = ra[key][k] / ra.n * 100, b = rb[key][k] / rb.n * 100, d = b - a
    if (a >= 99.99 && b >= 99.99) continue
    html += `<tr><td>${k + 1}点</td><td class="n">${a.toFixed(2)}%</td><td class="n">${b.toFixed(2)}%</td>`
      + `<td class="n ${d >= 0 ? 'up' : 'dn'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}pt</td></tr>`
  }
}
html += `</tbody></table>`

console.log(`対象 ${ra.n.toLocaleString()} レース${skip.size ? '（除外 ' + [...skip].join(',') + '）' : ''}`)
for (const [name, key] of [['1着', 'h1'], ['2連単', 'h2'], ['3連単', 'h3']]) {
  console.log(`${name.padEnd(4)} ` + PTS.map((k) =>
    `${k + 1}点 ${(ra[key][k] / ra.n * 100).toFixed(1)}→${(rb[key][k] / rb.n * 100).toFixed(1)}`).join('  '))
}
if (OUT) {
  let s = readFileSync(OUT, 'utf8')
  s = s.replace(/<div class="tw" id="tbl">[^]*?<\/div>/, `<div class="tw" id="tbl">${html}</div>`)
  writeFileSync(OUT, s)
  console.log(`\n書き込み ${OUT}`)
}
db.close()
