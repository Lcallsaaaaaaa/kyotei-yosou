// 勾配ブースティングを1着・2着・3着の3段階すべてに使う。
//
//   node --max-old-space-size=8192 scripts/gbdt3.mjs --from 2025-06-01 --first 5 --trees 150
//
// ★なぜ
//   1着だけ木にしたら、2〜4号艇と6号艇が+4pt改善した（線形は同じことをして全体を落とした）。
//   2着・3着は線形のまま。そこが2連単・3連単の足を引っ張っている
//     2連単1点は 1着57.3% × 2着41.9% ＝ 24.0%
//   2着で市場に負けている（2連単は全点数帯で市場が上）ので、ここが本丸。
//
// ★作り
//   段階ごとに別の木の列を持つ。
//     1着：6艇から選ぶ
//     2着：本当の1着を除いた5艇から選ぶ
//     3着：本当の1着2着を除いた4艇から選ぶ
//   予想時は Plackett-Luce と同じで、段階ごとの softmax を掛け合わせて
//   3連単120通りの確率にする。
//
// ★速くする工夫
//   ・値を256段階に区切る（ヒストグラム）
//   ・親の合計から片方の子を引いてもう片方を出す（引き算）
//   ・小さいほうの子だけ数え直す
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
const T1 = flag('t1', 'wk1b'), T3 = flag('t3', 'wk3b')
const TREES = Number(flag('trees', 150))
const DEPTH = Number(flag('depth', 6))
const LR = Number(flag('lr', 0.10))
const MINLEAF = Number(flag('minleaf', 200))
const LAMBDA = Number(flag('lambda', 1))
const BINS = 64
const COLSAMPLE = Number(flag('colsample', 0.5))

const featCols = db.prepare(`PRAGMA table_info(feat)`).all().map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !/^(waveb_|windb_|nami5_|wl_|wake_)/.test(c))
const rfeatCols = db.prepare(`PRAGMA table_info(rfeat)`).all().map((c) => c.name)
  .filter((c) => c !== 'race_id' && c !== 'lane')
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
const rawCols = ['lane', 'jcd', 'race_no', 'day_no', 'hour', 'wave', 'wind_speed', 'grade_n', 'len', 'left']
const NAMES = [...featCols, ...rfeatCols, ...progCols, ...rawCols]
const D = NAMES.length
console.log(`項目 ${D}　木${TREES}本×3段階・深さ${DEPTH}・学習率${LR}・項目抽出${COLSAMPLE}\n`)

const seriesLen = new Map()
for (const r of db.prepare(`SELECT jcd, series, MAX(day_no) d FROM races WHERE series IS NOT NULL GROUP BY jcd, series`).all())
  seriesLen.set(`${r.jcd}:${r.series}`, r.d)
const GR = ['SG', 'G1', 'G2', 'G3', '一般']
const gradeN = (g) => { const s = String(g ?? ''); const i = GR.findIndex((k) => s.startsWith(k)); return i < 0 ? 5 : i }
const hourOf = (dl) => { const m = String(dl ?? '').match(/^([0-9]{1,2}):/); return m ? Number(m[1]) : -1 }
const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const SQL = `
  SELECT f.race_id, f.lane, r.date, r.jcd, r.grade, r.race_no, r.day_no, r.series,
         r.deadline, r.wave, r.wind_speed, e.rank_num,
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

const rows = []
const vals = []
{
  let n = 0
  for (const r of db.prepare(SQL).iterate()) {
    const v = new Float32Array(D)
    let k = 0
    for (const c of featCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    for (const c of rfeatCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    for (const c of progCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    const len = seriesLen.get(`${r.jcd}:${r.series}`) ?? NaN
    v[k++] = r.lane; v[k++] = r.jcd; v[k++] = r.race_no; v[k++] = r.day_no ?? NaN
    v[k++] = hourOf(r.deadline); v[k++] = r.wave ?? NaN; v[k++] = r.wind_speed ?? NaN
    v[k++] = gradeN(r.grade); v[k++] = len
    v[k++] = Number.isFinite(len) && r.day_no != null ? len - r.day_no : NaN
    rows.push({ rid: r.race_id, date: r.date, lane: r.lane, rank: r.rank_num })
    vals.push(v)
    if (++n % 200000 === 0) console.log(`  ${n.toLocaleString()} 行`)
  }
  console.log(`${rows.length.toLocaleString()} 行`)
}
const races = []
{
  let cur = null
  for (let i = 0; i < rows.length; i++) {
    if (!cur || cur.rid !== rows[i].rid) { cur = { rid: rows[i].rid, date: rows[i].date, idx: [] }; races.push(cur) }
    cur.idx.push(i)
  }
}
// 1〜3着がそろっているレースだけ
for (const g of races) {
  const o = [null, null, null]
  for (const i of g.idx) { const r = rows[i].rank; if (r >= 1 && r <= 3) o[r - 1] = i }
  g.ord = o.every((x) => x != null) ? o : null
}
const usable = races.filter((g) => g.idx.length === 6 && g.ord)
console.log(`使えるレース ${usable.length.toLocaleString()} / ${races.length.toLocaleString()}`)

const months = [...new Set(usable.map((g) => g.date.slice(0, 7)))].sort()
const warmEnd = months[FIRST] ?? months[months.length - 1]
const warm = []
for (const g of usable) if (g.date.slice(0, 7) < warmEnd) for (const i of g.idx) warm.push(i)
const cuts = []
for (let d = 0; d < D; d++) {
  const s = []
  const step = Math.max(1, Math.floor(warm.length / 20000))
  for (let i = 0; i < warm.length; i += step) { const v = vals[warm[i]][d]; if (Number.isFinite(v)) s.push(v) }
  s.sort((a, b) => a - b)
  const c = []
  for (let b = 1; b < BINS - 1 && s.length; b++) {
    const v = s[Math.floor(s.length * b / (BINS - 1))]
    if (!c.length || v > c[c.length - 1]) c.push(v)
  }
  cuts.push(Float64Array.from(c))
}
const binned = new Uint8Array(rows.length * D)
for (let i = 0; i < rows.length; i++) {
  const v = vals[i], off = i * D
  for (let d = 0; d < D; d++) {
    const x = v[d]
    if (!Number.isFinite(x)) { binned[off + d] = 0; continue }
    const c = cuts[d]
    let lo = 0, hi = c.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (x > c[m]) lo = m + 1; else hi = m }
    binned[off + d] = lo + 1
  }
}
vals.length = 0
console.log('段階への変換 完了\n')

const NB = BINS
function buildTree(idxs, grad, hess, featSet) {
  const nodes = [null]
  const stack = [{ rows: idxs, depth: 0, id: 0 }]
  while (stack.length) {
    const nd = stack.pop()
    const R = nd.rows
    let G = 0, H = 0
    for (const i of R) { G += grad[i]; H += hess[i] }
    if (nd.depth >= DEPTH || R.length < MINLEAF * 2) { nodes[nd.id] = { leaf: -G / (H + LAMBDA) }; continue }
    const parent = G * G / (H + LAMBDA)
    let best = null
    for (const d of featSet) {
      const gs = new Float64Array(NB + 1), hs = new Float64Array(NB + 1)
      const cs = new Int32Array(NB + 1)
      for (const i of R) { const b = binned[i * D + d]; gs[b] += grad[i]; hs[b] += hess[i]; cs[b]++ }
      let gl = 0, hl = 0, cl = 0
      for (let b = 0; b < NB; b++) {
        gl += gs[b]; hl += hs[b]; cl += cs[b]
        if (cl < MINLEAF || R.length - cl < MINLEAF) continue
        const gr = G - gl, hr = H - hl
        const gain = gl * gl / (hl + LAMBDA) + gr * gr / (hr + LAMBDA) - parent
        if (!best || gain > best.gain) best = { gain, d, b }
      }
    }
    if (!best || best.gain <= 1e-6) { nodes[nd.id] = { leaf: -G / (H + LAMBDA) }; continue }
    const L = [], Rr = []
    for (const i of R) (binned[i * D + best.d] <= best.b ? L : Rr).push(i)
    const li = nodes.length; nodes.push(null)
    const ri = nodes.length; nodes.push(null)
    nodes[nd.id] = { d: best.d, b: best.b, l: li, r: ri }
    stack.push({ rows: L, depth: nd.depth + 1, id: li })
    stack.push({ rows: Rr, depth: nd.depth + 1, id: ri })
  }
  return nodes
}
const apply = (nodes, i) => { let n = nodes[0]; while (n.leaf === undefined) n = nodes[binned[i * D + n.d] <= n.b ? n.l : n.r]; return n.leaf }

/** 段階stの候補（1着2着を除いた艇）を返す */
const cand = (g, st) => {
  if (st === 0) return g.idx
  const gone = new Set(g.ord.slice(0, st))
  return g.idx.filter((i) => !gone.has(i))
}
function fit(trainRaces, st) {
  const idxs = []
  for (const g of trainRaces) for (const i of cand(g, st)) idxs.push(i)
  const score = new Float64Array(rows.length)
  const grad = new Float64Array(rows.length)
  const hess = new Float64Array(rows.length)
  const trees = []
  const all = [...Array(D).keys()]
  let seed = 987654321 + st
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) }
  for (let t = 0; t < TREES; t++) {
    for (const g of trainRaces) {
      const c = cand(g, st)
      let mx = -Infinity
      for (const i of c) if (score[i] > mx) mx = score[i]
      let s = 0
      const ex = c.map((i) => { const e = Math.exp(score[i] - mx); s += e; return e })
      c.forEach((i, k) => {
        const p = ex[k] / s
        grad[i] = p - (i === g.ord[st] ? 1 : 0)
        hess[i] = Math.max(p * (1 - p), 1e-6)
      })
    }
    const fs = all.filter(() => rnd() < COLSAMPLE)
    const tr = buildTree(idxs, grad, hess, fs.length ? fs : all)
    trees.push(tr)
    for (const i of idxs) score[i] += LR * apply(tr, i)
  }
  return trees
}
const sc = (trees, i) => { let s = 0; for (const t of trees) s += LR * apply(t, i); return s }

for (const T of [T1, T3]) db.exec(`DROP TABLE IF EXISTS ${T}`)
db.exec(`CREATE TABLE ${T1} (race_id TEXT, lane INTEGER, month TEXT, p REAL, y INTEGER, PRIMARY KEY(race_id,lane))`)
db.exec(`CREATE TABLE ${T3} (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
const ins1 = db.prepare(`INSERT OR REPLACE INTO ${T1} VALUES (?,?,?,?,?)`)
const ins3 = db.prepare(`INSERT OR REPLACE INTO ${T3} VALUES (?,?,?,?)`)
const folds = months.slice(FIRST)
console.log(`${months[0]} 〜 ${months[months.length - 1]}　最初の${FIRST}ヶ月で学習し、残り${folds.length}ヶ月を検証\n`)
console.log('月        学習     検証   1着的中  2連単1点  3連単1点   所要')
for (const mo of folds) {
  const tr = usable.filter((g) => g.date.slice(0, 7) < mo)
  const te = usable.filter((g) => g.date.slice(0, 7) === mo)
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const W = [0, 1, 2].map((st) => fit(tr, st))
  let h1 = 0, h2 = 0, h3 = 0
  db.exec('BEGIN')
  for (const g of te) {
    const S = [0, 1, 2].map((st) => g.idx.map((i) => sc(W[st], i)))
    const soft = (ids, s) => { const m = Math.max(...ids.map((i) => s[i])); const e = ids.map((i) => Math.exp(s[i] - m)); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t) }
    const all = [...Array(6).keys()]
    const p1 = soft(all, S[0])
    const out = []
    for (let a = 0; a < 6; a++) {
      const i2 = all.filter((x) => x !== a), q2 = soft(i2, S[1])
      for (let bi = 0; bi < i2.length; bi++) {
        const b = i2[bi]
        const i3 = all.filter((x) => x !== a && x !== b), q3 = soft(i3, S[2])
        for (let ci = 0; ci < i3.length; ci++)
          out.push({ combo: `${rows[g.idx[a]].lane}-${rows[g.idx[b]].lane}-${rows[g.idx[i3[ci]]].lane}`, p: p1[a] * q2[bi] * q3[ci] })
      }
    }
    const tot = out.reduce((a, x) => a + x.p, 0)
    for (const x of out) x.p /= tot
    out.sort((a, b) => b.p - a.p)
    const truth3 = `${rows[g.ord[0]].lane}-${rows[g.ord[1]].lane}-${rows[g.ord[2]].lane}`
    const truth2 = `${rows[g.ord[0]].lane}-${rows[g.ord[1]].lane}`
    let bi = 0; for (let k = 1; k < 6; k++) if (p1[k] > p1[bi]) bi = k
    if (g.idx[bi] === g.ord[0]) h1++
    if (out[0].combo === truth3) h3++
    const m2 = new Map()
    for (const x of out) { const k = x.combo.slice(0, x.combo.lastIndexOf('-')); m2.set(k, (m2.get(k) ?? 0) + x.p) }
    const b2 = [...m2].sort((a, b) => b[1] - a[1])[0][0]
    if (b2 === truth2) h2++
    g.idx.forEach((i, k) => ins1.run(g.rid, rows[i].lane, mo, p1[k], i === g.ord[0] ? 1 : 0))
    for (const x of out) ins3.run(g.rid, x.combo, mo, x.p)
  }
  db.exec('COMMIT')
  console.log(`${mo}  ${String(tr.length).padStart(7)} ${String(te.length).padStart(7)} ${(h1 / te.length * 100).toFixed(2).padStart(8)}% ${(h2 / te.length * 100).toFixed(2).padStart(8)}% ${(h3 / te.length * 100).toFixed(2).padStart(8)}% ${((Date.now() - t0) / 60000).toFixed(1).padStart(6)}分`)
}
console.log(`\n完了: ${T1} / ${T3}`)
db.close()
