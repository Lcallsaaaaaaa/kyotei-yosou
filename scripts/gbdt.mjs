// 勾配ブースティング（決定木を足していく形）で1着を予想する。
//
//   node --max-old-space-size=8192 scripts/gbdt.mjs --from 2025-06-01 --first 5 --t1 wg1b --t3 wg3b
//   node --max-old-space-size=8192 scripts/gbdt.mjs --trees 400 --depth 6 --lr 0.06
//
// ★なぜ作るか
//   いまのモデルは**線形**。項目に係数を掛けて足すだけで、掛け合わせは
//   私が手で決めた9項目（場×コースなど）しかない。
//   案Dで掛け合わせを増やしたが、どの組を作るかを人が決めている時点で限界がある。
//   決定木を足していく形なら、項目の組み合わせを**自動で見つける**。
//   競馬・競艇の研究ではこの形（LightGBM/CatBoost等）が主流になっている。
//
// ★目的関数
//   レース内6艇の softmax。1着になった艇の確率を上げる。
//   各艇のずれ  g = p - y、曲がり具合 h = p(1-p)
//   これは線形モデルと同じ目的で、当てはめる関数だけを木に替えた形。
//   線形との差＝「形」の差だけを見たいので、項目も期間も同じにする。
//
// ★速さの工夫
//   ・各項目を256段階に区切っておく（ヒストグラム）。木を作るときは段階ごとの合計だけ見る
//   ・親の合計から片方の子を引いてもう片方を出す（引き算のテクニック）
//   ・欠けている値は片側にまとめて置く（0段階目）
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
const T1 = flag('t1', 'wgb1'), T3 = flag('t3', 'wgb3')
const TREES = Number(flag('trees', 300))
const DEPTH = Number(flag('depth', 6))
const LR = Number(flag('lr', 0.08))
const MINLEAF = Number(flag('minleaf', 200))
const LAMBDA = Number(flag('lambda', 1))
const BINS = 64
const COLSAMPLE = Number(flag('colsample', 0.7))
const NOLIVE = argv.includes('--nolive')
const LIVEPAT = /^(ex_|exc_|exst_|tilt_|adj_|air_|water_|temp_|parts_)/

// ---------- 項目（線形モデルと同じ並び） ----------
const featCols = db.prepare(`PRAGMA table_info(feat)`).all().map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !/^(waveb_|windb_|nami5_|wl_|wake_)/.test(c))
const rfeatCols = db.prepare(`PRAGMA table_info(rfeat)`).all().map((c) => c.name)
  .filter((c) => c !== 'race_id' && c !== 'lane')
  .filter((c) => !(NOLIVE && LIVEPAT.test(c)))
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
// 木は数値をそのまま分けられるので、条件は生の値で渡してよい（ダミーにしなくてよい）
const rawCols = ['lane', 'jcd', 'race_no', 'day_no', 'hour', 'wave', 'wind_speed', 'grade_n', 'len', 'left']
const NAMES = [...featCols, ...rfeatCols, ...progCols, ...rawCols]
const D = NAMES.length
console.log(`項目 ${D}（艇${featCols.length} + レース${rfeatCols.length} + 番組表${progCols.length} + 生${rawCols.length}）`)
console.log(`木${TREES}本・深さ${DEPTH}・学習率${LR}・区切り${BINS}段階・項目抽出${COLSAMPLE}\n`)

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

// ---------- 読み込み（値は Float32 で1本の配列に詰める） ----------
const rows = []   // {race_id, date, lane, y}
const vals = []   // Float32Array(D) を行ごとに
{
  let n = 0
  for (const r of db.prepare(SQL).iterate()) {
    const v = new Float32Array(D)
    let k = 0
    for (const c of featCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    for (const c of rfeatCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    for (const c of progCols) { const x = r[c]; v[k++] = x == null ? NaN : x }
    const len = seriesLen.get(`${r.jcd}:${r.series}`) ?? NaN
    v[k++] = r.lane
    v[k++] = r.jcd
    v[k++] = r.race_no
    v[k++] = r.day_no ?? NaN
    v[k++] = hourOf(r.deadline)
    v[k++] = r.wave ?? NaN
    v[k++] = r.wind_speed ?? NaN
    v[k++] = gradeN(r.grade)
    v[k++] = len
    v[k++] = Number.isFinite(len) && r.day_no != null ? len - r.day_no : NaN
    rows.push({ rid: r.race_id, date: r.date, lane: r.lane, y: r.rank_num === 1 ? 1 : 0, rank: r.rank_num })
    vals.push(v)
    if (++n % 200000 === 0) console.log(`  ${n.toLocaleString()} 行`)
  }
  console.log(`${rows.length.toLocaleString()} 行`)
}

// レースにまとめる（6艇そろって1着が1つのものだけ）
const races = []
{
  let cur = null
  for (let i = 0; i < rows.length; i++) {
    if (!cur || cur.rid !== rows[i].rid) { cur = { rid: rows[i].rid, date: rows[i].date, idx: [] }; races.push(cur) }
    cur.idx.push(i)
  }
}
const usable = races.filter((g) => g.idx.length === 6 && g.idx.filter((i) => rows[i].y).length === 1)
console.log(`使えるレース ${usable.length.toLocaleString()} / ${races.length.toLocaleString()}`)

// ---------- 区切り（ヒストグラム）を作る ----------
// 学習に使う最初の窓だけで境目を決める。月ごとに作り直すと値の意味がずれる。
const months = [...new Set(usable.map((g) => g.date.slice(0, 7)))].sort()
const warmEnd = months[FIRST] ?? months[months.length - 1]
const warmRows = []
for (const g of usable) { if (g.date.slice(0, 7) < warmEnd) for (const i of g.idx) warmRows.push(i) }
console.log(`区切りを決めるのに使う行 ${warmRows.length.toLocaleString()}`)

const cuts = []          // 項目ごとの境目（昇順）
for (let d = 0; d < D; d++) {
  const s = []
  const step = Math.max(1, Math.floor(warmRows.length / 20000))
  for (let i = 0; i < warmRows.length; i += step) { const v = vals[warmRows[i]][d]; if (Number.isFinite(v)) s.push(v) }
  s.sort((a, b) => a - b)
  const c = []
  if (s.length) {
    for (let b = 1; b < BINS - 1; b++) {
      const v = s[Math.floor(s.length * b / (BINS - 1))]
      if (!c.length || v > c[c.length - 1]) c.push(v)
    }
  }
  cuts.push(Float64Array.from(c))
}
// 全行を段階に直す（0＝欠け、1以上＝値の段階）
const NB = BINS
const binned = new Uint8Array(rows.length * D)
{
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
    if ((i + 1) % 300000 === 0) console.log(`  段階に変換 ${(i + 1).toLocaleString()}`)
  }
  vals.length = 0   // 元の値はもう要らない
}
console.log('段階への変換 完了\n')

// ---------- 決定木 ----------
/** ひとつの木を作る。grad/hess は行ごと。idxs はこの木で使う行 */
function buildTree(idxs, grad, hess, featSet) {
  const nodes = []
  const stack = [{ rows: idxs, depth: 0, id: 0 }]
  nodes.push(null)
  while (stack.length) {
    const nd = stack.pop()
    const rowsN = nd.rows
    let G = 0, H = 0
    for (const i of rowsN) { G += grad[i]; H += hess[i] }
    if (nd.depth >= DEPTH || rowsN.length < MINLEAF * 2) {
      nodes[nd.id] = { leaf: -G / (H + LAMBDA) }
      continue
    }
    const parentGain = G * G / (H + LAMBDA)
    let best = null
    for (const d of featSet) {
      const gs = new Float64Array(NB + 1), hs = new Float64Array(NB + 1)
      const cs = new Int32Array(NB + 1)
      for (const i of rowsN) { const b = binned[i * D + d]; gs[b] += grad[i]; hs[b] += hess[i]; cs[b]++ }
      // 欠け（段階0）は左に置く
      let gl = 0, hl = 0, cl = 0
      for (let b = 0; b < NB; b++) {
        gl += gs[b]; hl += hs[b]; cl += cs[b]
        if (cl < MINLEAF || rowsN.length - cl < MINLEAF) continue
        const gr = G - gl, hr = H - hl
        const gain = gl * gl / (hl + LAMBDA) + gr * gr / (hr + LAMBDA) - parentGain
        if (!best || gain > best.gain) best = { gain, d, b }
      }
    }
    if (!best || best.gain <= 1e-6) { nodes[nd.id] = { leaf: -G / (H + LAMBDA) }; continue }
    const L = [], R = []
    for (const i of rowsN) (binned[i * D + best.d] <= best.b ? L : R).push(i)
    const li = nodes.length; nodes.push(null)
    const ri = nodes.length; nodes.push(null)
    nodes[nd.id] = { d: best.d, b: best.b, l: li, r: ri }
    stack.push({ rows: L, depth: nd.depth + 1, id: li })
    stack.push({ rows: R, depth: nd.depth + 1, id: ri })
  }
  return nodes
}
const applyTree = (nodes, i) => {
  let n = nodes[0]
  while (n.leaf === undefined) n = nodes[binned[i * D + n.d] <= n.b ? n.l : n.r]
  return n.leaf
}

/** レース内 softmax で学習する */
function fit(trainRaces) {
  const idxs = []
  for (const g of trainRaces) for (const i of g.idx) idxs.push(i)
  const score = new Float64Array(rows.length)
  const grad = new Float64Array(rows.length)
  const hess = new Float64Array(rows.length)
  const trees = []
  const featAll = [...Array(D).keys()]
  let seed = 12345
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) }
  for (let t = 0; t < TREES; t++) {
    // ずれを計算
    for (const g of trainRaces) {
      let mx = -Infinity
      for (const i of g.idx) if (score[i] > mx) mx = score[i]
      let s = 0
      const ex = g.idx.map((i) => { const e = Math.exp(score[i] - mx); s += e; return e })
      g.idx.forEach((i, k) => {
        const p = ex[k] / s
        grad[i] = p - rows[i].y
        hess[i] = Math.max(p * (1 - p), 1e-6)
      })
    }
    const featSet = featAll.filter(() => rnd() < COLSAMPLE)
    const tree = buildTree(idxs, grad, hess, featSet.length ? featSet : featAll)
    trees.push(tree)
    for (const i of idxs) score[i] += LR * applyTree(tree, i)
  }
  return trees
}
const predict = (trees, i) => { let s = 0; for (const t of trees) s += LR * applyTree(t, i); return s }

// ---------- 歩進検証 ----------
for (const T of [T1, T3]) db.exec(`DROP TABLE IF EXISTS ${T}`)
db.exec(`CREATE TABLE ${T1} (race_id TEXT, lane INTEGER, month TEXT, p REAL, y INTEGER, PRIMARY KEY(race_id,lane))`)
db.exec(`CREATE TABLE ${T3} (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
const ins1 = db.prepare(`INSERT OR REPLACE INTO ${T1} VALUES (?,?,?,?,?)`)
const folds = months.slice(FIRST)
console.log(`${months[0]} 〜 ${months[months.length - 1]}　最初の${FIRST}ヶ月で学習し、残り${folds.length}ヶ月を検証\n`)
console.log('月        学習     検証    1着的中   学習した月   所要')
for (const mo of folds) {
  const tr = usable.filter((g) => g.date.slice(0, 7) < mo)
  const te = usable.filter((g) => g.date.slice(0, 7) === mo)
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const trees = fit(tr)
  let hit = 0
  db.exec('BEGIN')
  for (const g of te) {
    const s = g.idx.map((i) => predict(trees, i))
    const mx = Math.max(...s)
    const ex = s.map((v) => Math.exp(v - mx))
    const sum = ex.reduce((a, b) => a + b, 0)
    let bi = 0
    for (let k = 1; k < 6; k++) if (ex[k] > ex[bi]) bi = k
    if (rows[g.idx[bi]].y === 1) hit++
    g.idx.forEach((i, k) => ins1.run(g.rid, rows[i].lane, mo, ex[k] / sum, rows[i].y))
  }
  db.exec('COMMIT')
  const smp = tr.slice(-Math.min(2000, tr.length))
  let hin = 0
  for (const g of smp) {
    const s = g.idx.map((i) => predict(trees, i))
    let bi = 0; for (let k = 1; k < 6; k++) if (s[k] > s[bi]) bi = k
    if (rows[g.idx[bi]].y === 1) hin++
  }
  console.log(`${mo}  ${String(tr.length).padStart(7)} ${String(te.length).padStart(7)} ${(hit / te.length * 100).toFixed(2).padStart(9)}% ${(hin / smp.length * 100).toFixed(2).padStart(10)}% ${((Date.now() - t0) / 60000).toFixed(1).padStart(6)}分`)
}
console.log(`\n完了: ${T1}`)
db.close()
