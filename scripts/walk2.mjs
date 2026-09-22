// 2着専用のモデル。「誰が1着だったか」で係数を分ける。
//
//   node --max-old-space-size=8192 scripts/walk2.mjs --p1 wi1 --out w2 --from 2025-06-01 --first 5
//
// ★なぜ要るか
//   2連単1点の的中は24.02%。内訳は 1着57.35% × 2着41.89% で、**足を引っ張るのは2着**。
//   1着を80%当てられるレースだけ選んでも、2連単は33.26%にしかならない。
//
//   いまのモデルは2着を選ぶときも「1着に選ばれなかった艇の中で強い順」に見ているだけで、
//   **誰が1着だったかで場合分けしていない**。
//   1号艇が逃げたときの2着（差しに来る2号艇か、まくり差しの3号艇か）と、
//   4号艇がまくったときの2着（内で粘る1号艇か、連れて来る5号艇か）は、まったく別の問題。
//
// ★やること
//   2着用の係数を「1着だった枠」ごとに6組つくる。
//   学習時は本当の1着で場合分けし、予想時は
//     P(a-b) = P(1着=a) × P(2着=b | 1着=a)
//   で組み立てる。P(1着=a) は既存のモデル（--p1 のテーブル）をそのまま使う。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const FROM = flag('from', '2025-06-01')
const FIRST = Number(flag('first', 5))
const P1T = flag('p1', 'wi1')          // 1着確率をどのテーブルから取るか
const OUT = flag('out', 'w2')
const L2 = Number(flag('l2', 0.001))
const EPOCHS = Number(flag('epochs', 50))

const featCols = db.prepare(`PRAGMA table_info(feat)`).all().map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !/^(waveb_|windb_|nami5_|wl_|wake_)/.test(c))
const rfeatCols = db.prepare(`PRAGMA table_info(rfeat)`).all().map((c) => c.name)
  .filter((c) => c !== 'race_id' && c !== 'lane')
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
const D = featCols.length + rfeatCols.length + progCols.length + 6
console.log(`項目 ${D}（艇${featCols.length} + レース${rfeatCols.length} + 番組表${progCols.length} + 枠6）`)
console.log(`2着用の係数を「1着だった枠」ごとに6組 = ${(D * 6).toLocaleString()}個\n`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const SQL = `
  SELECT f.race_id, f.lane, r.date, e.rank_num,
    ${progCols.map((c) => `p.${q(c)}`).join(', ')},
    ${featCols.map((c) => `f.${q(c)}`).join(', ')},
    ${rfeatCols.map((c) => `rf.${q(c)}`).join(', ')}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  LEFT JOIN rfeat rf ON rf.race_id = f.race_id AND rf.lane = f.lane
  WHERE r.date >= '${FROM}'
  ORDER BY r.date, f.race_id, f.lane`

const vec = (r) => {
  const v = new Float32Array(D)
  let k = 0
  for (const c of featCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of rfeatCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of progCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  if (r.lane >= 1 && r.lane <= 6) v[k + r.lane - 1] = 1
  return v
}

const races = []
{
  let cur = null, n = 0
  for (const r of db.prepare(SQL).iterate()) {
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), lane: r.lane })
    if (++n % 200000 === 0) console.log(`  ${n.toLocaleString()} 行`)
  }
  console.log(`${n.toLocaleString()} 行 / ${races.length.toLocaleString()} レース`)
}
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 2`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
for (const g of races) { const m = ORD.get(g.race_id); g.ord = m && m[1] && m[2] ? [m[1], m[2]] : null }
const usable = races.filter((g) => g.boats.length === 6 && g.ord)
console.log(`使えるレース ${usable.length.toLocaleString()}`)

// 1着確率（既存モデル）
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, month FROM ${P1T}`).iterate()) {
  let m = P1.get(r.race_id); if (!m) { m = { mo: r.month, p: {} }; P1.set(r.race_id, m) }
  m.p[r.lane] = r.p
}
console.log(`1着確率 ${P1.size.toLocaleString()}レース（${P1T}）`)

// 標準化
{
  const mean = new Float64Array(D), sd = new Float64Array(D)
  let n = 0
  for (const g of usable) for (const b of g.boats) { for (let d = 0; d < D; d++) mean[d] += b.x[d]; n++ }
  for (let d = 0; d < D; d++) mean[d] /= n
  for (const g of usable) for (const b of g.boats) for (let d = 0; d < D; d++) sd[d] += (b.x[d] - mean[d]) ** 2
  for (let d = 0; d < D; d++) { sd[d] = Math.sqrt(sd[d] / n); if (!(sd[d] > 1e-9)) sd[d] = 1 }
  for (const g of usable) for (const b of g.boats)
    for (let d = 0; d < D; d++) b.x[d] = (b.x[d] - mean[d]) / sd[d]
  console.log('標準化 完了')
}

/** 1着だった枠ごとに、残り5艇から2着を選ぶ係数を学習する */
function fit(rs) {
  const W = [...Array(6)].map(() => new Float64Array(D))
  const M = [...Array(6)].map(() => new Float64Array(D))
  const V = [...Array(6)].map(() => new Float64Array(D))
  const cnt = new Array(6).fill(0)
  for (const g of rs) cnt[g.ord[0] - 1]++
  for (let ep = 1; ep <= EPOCHS; ep++) {
    const G = [...Array(6)].map(() => new Float64Array(D))
    for (const g of rs) {
      const bs = g.boats, L = g.ord[0] - 1, w = W[L], gr = G[L]
      const cand = [], idx = new Map()
      for (let i = 0; i < 6; i++) if (bs[i].lane !== g.ord[0]) { idx.set(bs[i].lane, cand.length); cand.push(i) }
      const s = cand.map((i) => { const x = bs[i].x; let z = 0; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z })
      const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
      const sum = ex.reduce((a, b) => a + b, 0)
      const pick = idx.get(g.ord[1]); if (pick === undefined) continue
      for (let k = 0; k < cand.length; k++) {
        const p = ex[k] / sum, x = bs[cand[k]].x
        const c = k === pick ? p - 1 : p
        for (let d = 0; d < D; d++) gr[d] += c * x[d]
      }
    }
    for (let L = 0; L < 6; L++) {
      const n = Math.max(cnt[L], 1), w = W[L], m = M[L], v = V[L], gr = G[L]
      for (let d = 0; d < D; d++) {
        const gi = gr[d] / n + L2 * w[d]
        m[d] = 0.9 * m[d] + 0.1 * gi
        v[d] = 0.999 * v[d] + 0.001 * gi * gi
        w[d] -= 0.25 * (m[d] / (1 - 0.9 ** ep)) / (Math.sqrt(v[d] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
  }
  return W
}

db.exec(`DROP TABLE IF EXISTS ${OUT}`)
db.exec(`CREATE TABLE ${OUT} (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
const ins = db.prepare(`INSERT OR REPLACE INTO ${OUT} VALUES (?,?,?,?)`)

const months = [...new Set(usable.map((g) => g.date.slice(0, 7)))].sort()
const folds = months.slice(FIRST)
console.log(`\n${months[0]} 〜 ${months[months.length - 1]}　最初の${FIRST}ヶ月で学習し、残り${folds.length}ヶ月を検証\n`)
console.log('月        学習     検証   2連単1点   1着が合ったとき2着も合う   所要')
for (const mo of folds) {
  const tr = usable.filter((g) => g.date.slice(0, 7) < mo)
  const te = usable.filter((g) => g.date.slice(0, 7) === mo && P1.has(g.race_id))
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const W = fit(tr)
  let h2 = 0, h1 = 0, both = 0
  db.exec('BEGIN')
  for (const g of te) {
    const bs = g.boats, pm = P1.get(g.race_id)
    const out = []
    for (const a of bs) {
      const p1 = pm.p[a.lane] ?? 0
      if (!(p1 > 0)) continue
      const w = W[a.lane - 1]
      const cand = bs.filter((b) => b.lane !== a.lane)
      const s = cand.map((b) => { const x = b.x; let z = 0; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z })
      const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
      const sum = ex.reduce((x, y) => x + y, 0)
      cand.forEach((b, k) => out.push({ combo: `${a.lane}-${b.lane}`, p: p1 * ex[k] / sum }))
    }
    const t = out.reduce((a, x) => a + x.p, 0) || 1
    for (const x of out) x.p /= t
    out.sort((a, b) => b.p - a.p)
    for (const x of out) ins.run(g.race_id, x.combo, mo, x.p)
    const truth = `${g.ord[0]}-${g.ord[1]}`
    if (out[0].combo === truth) h2++
    const topLane = Number(out[0].combo.slice(0, out[0].combo.indexOf('-')))
    if (topLane === g.ord[0]) { h1++; if (out[0].combo === truth) both++ }
  }
  db.exec('COMMIT')
  console.log(`${mo}  ${String(tr.length).padStart(7)} ${String(te.length).padStart(7)} ${(h2 / te.length * 100).toFixed(2).padStart(9)}% ${(both / Math.max(h1, 1) * 100).toFixed(2).padStart(22)}% ${((Date.now() - t0) / 60000).toFixed(1).padStart(6)}分`)
}
console.log(`\n完了: ${OUT}`)
db.close()
