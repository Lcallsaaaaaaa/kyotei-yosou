// Plackett-Luce v3：レース条件（グレード・種別・日目・風）を交互作用として入れる。
//
//   node scripts/model3.mjs                       全部入り
//   node scripts/model3.mjs --off grade,wind      一部を外して寄与を見る
//   node scripts/model3.mjs --off all             v2相当（条件なし）
//
// ★入れ方の考え方
//   グレードや風は「どの艇が強いか」ではなく「**内寄りのコースがどれだけ有利か**」を動かす。
//   例：G1は1コース65.5%、G3女子は52.7%。風8mでは1コースが46.8%まで落ちる。
//   なので各条件を「内寄り度」との掛け算（交互作用）として1本ずつ入れる。
//     内寄り度 = (3.5 − コース) / 2.5   → 1コース+1.0 … 6コース−1.0
//   条件の値は**学習期間だけ**から測った「その条件での1コース1着率 − 全体平均」を使う。
//   こうすると1条件につきパラメータ1個で済み、どの条件がどれだけ効いたかが重みで読める。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const SPLIT = flag('split', '2026-02-18')
const VALID = flag('valid', '2026-01-01')
const OFF = new Set((flag('off', '') || '').split(',').map((x) => x.trim()).filter(Boolean))
const useCond = (name) => !OFF.has('all') && !OFF.has(name)

const K = 25
const shrink = (h, n, prior) => (h + K * prior) / (n + K)
const NSTAGE = 3
const stageOf = (step) => Math.min(step, NSTAGE - 1)
const innerness = (c) => (3.5 - c) / 2.5

const CONDS = ['grade', 'title', 'day', 'wind', 'winddir'].filter(useCond)
const FEATURES = [
  'course2', 'course3', 'course4', 'course5', 'course6',
  'racerP1', 'racerP2', 'racerP3', 'racerST',
  'venueBase', 'grade級', 'winRate', 'motor', 'exhibition',
  ...CONDS.map((c) => `cond_${c}`),
]
const NF = FEATURES.length
const NW = NSTAGE * NF
const GRADE = { A1: 3, A2: 2, B1: 1, B2: 0 }

// ---------- 学習期間から統計を作る ----------
function buildStats(cutoff) {
  const q = (sql, ...p) => all(sql, ...p)
  const venueBase = {}
  for (const r of q(`SELECT r.jcd, e.course c, COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY r.jcd, e.course`, cutoff))
    venueBase[`${r.jcd}:${r.c}`] = r.w / r.n

  const courseBase = {}
  for (const r of q(`SELECT e.course c, COUNT(*) n, SUM(e.rank_num=1) p1,
      SUM(e.rank_num=2) p2, SUM(e.rank_num=3) p3, AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY e.course`, cutoff))
    courseBase[r.c] = { p1: r.p1 / r.n, p2: r.p2 / r.n, p3: r.p3 / r.n, st: r.st }

  const racer = new Map()
  for (const r of q(`SELECT e.racer_id, e.course c, COUNT(*) n, SUM(e.rank_num=1) p1,
      SUM(e.rank_num=2) p2, SUM(e.rank_num=3) p3, AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND e.racer_id IS NOT NULL AND r.date < ?
    GROUP BY e.racer_id, e.course`, cutoff))
    racer.set(`${r.racer_id}:${r.c}`, r)

  // 全体の1コース1着率（条件値の基準）
  const g = q(`SELECT COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 AND r.date < ?`, cutoff)[0]
  const globalIn = g.w / g.n

  // 条件ごとの「1コース1着率 − 全体平均」
  const mk = (rows, keyf) => {
    const m = {}
    for (const r of rows) if (r.n >= 200) m[keyf(r)] = r.w / r.n - globalIn
    return m
  }
  const cond = {
    grade: mk(q(`SELECT r.grade k, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e
      JOIN races r ON r.race_id=e.race_id WHERE e.course=1 AND r.date < ? GROUP BY r.grade`, cutoff), (r) => r.k),
    title: mk(q(`SELECT r.title k, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e
      JOIN races r ON r.race_id=e.race_id WHERE e.course=1 AND r.date < ? GROUP BY r.title`, cutoff), (r) => r.k),
    day: mk(q(`SELECT MIN(r.day_no,8) k, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e
      JOIN races r ON r.race_id=e.race_id WHERE e.course=1 AND r.date < ? GROUP BY k`, cutoff), (r) => String(r.k)),
    wind: mk(q(`SELECT MIN(r.wind_speed,8) k, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e
      JOIN races r ON r.race_id=e.race_id WHERE e.course=1 AND r.date < ? GROUP BY k`, cutoff), (r) => String(r.k)),
    winddir: mk(q(`SELECT r.jcd||'|'||r.wind_dir k, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e
      JOIN races r ON r.race_id=e.race_id WHERE e.course=1 AND r.date < ? AND r.wind_dir IS NOT NULL
      AND r.wind_speed >= 3 GROUP BY k`, cutoff), (r) => r.k),
  }
  return { venueBase, courseBase, racer, cond, globalIn }
}

function buildDataset(st, from, to) {
  const rows = all(`
    SELECT e.race_id, r.jcd, e.lane, e.course, e.rank_num, e.racer_id, e.exhibition,
           r.grade, r.title, r.day_no, r.wind_speed, r.wind_dir,
           p.grade AS pgrade, p.win_rate_nat, p.motor_top2
    FROM entries e JOIN races r ON r.race_id = e.race_id
    LEFT JOIN programs p ON p.race_id = e.race_id AND p.lane = e.lane
    WHERE r.date >= ? AND r.date < ? AND e.course IS NOT NULL AND e.rank_num IS NOT NULL`, from, to)

  const byRace = new Map()
  for (const r of rows) {
    if (!byRace.has(r.race_id)) byRace.set(r.race_id, [])
    byRace.get(r.race_id).push(r)
  }

  const data = []
  for (const [, boats] of byRace) {
    if (boats.length !== 6) continue
    if (new Set(boats.map((b) => b.rank_num)).size !== 6) continue
    if (boats.some((b) => b.exhibition == null)) continue
    const h = boats[0]

    // レース単位の条件値（内寄り度と掛ける前の係数）
    const cv = {
      grade: st.cond.grade[h.grade] ?? 0,
      title: st.cond.title[h.title] ?? 0,
      day: st.cond.day[String(Math.min(h.day_no ?? 1, 8))] ?? 0,
      wind: st.cond.wind[String(Math.min(h.wind_speed ?? 2, 8))] ?? 0,
      winddir: (h.wind_speed ?? 0) >= 3 ? (st.cond.winddir[`${h.jcd}|${h.wind_dir}`] ?? 0) : 0,
    }

    const raw = boats.map((b) => {
      const cb = st.courseBase[b.course]
      const rs = st.racer.get(`${b.racer_id}:${b.course}`) ?? { n: 0, p1: 0, p2: 0, p3: 0, st: null }
      return {
        course: b.course, rank: b.rank_num,
        racerP1: shrink(rs.p1, rs.n, cb.p1),
        racerP2: shrink(rs.p2, rs.n, cb.p2),
        racerP3: shrink(rs.p3, rs.n, cb.p3),
        racerST: -(rs.st ?? cb.st),
        venueBase: st.venueBase[`${b.jcd}:${b.course}`] ?? cb.p1,
        gradeK: GRADE[b.pgrade] ?? 1,
        winRate: b.win_rate_nat ?? 5,
        motor: (b.motor_top2 ?? 33) / 100,
        exhibition: -b.exhibition,
      }
    })
    const cen = ['racerP1', 'racerP2', 'racerP3', 'racerST', 'gradeK', 'winRate', 'motor', 'exhibition']
    const mean = {}
    for (const k of cen) mean[k] = raw.reduce((a, b) => a + b[k], 0) / raw.length

    const X = raw.map((b) => {
      const f = []
      for (let c = 2; c <= 6; c++) f.push(b.course === c ? 1 : 0)
      f.push(b.racerP1 - mean.racerP1)
      f.push(b.racerP2 - mean.racerP2)
      f.push(b.racerP3 - mean.racerP3)
      f.push((b.racerST - mean.racerST) * 10)
      f.push(b.venueBase)
      f.push(b.gradeK - mean.gradeK)
      f.push(b.winRate - mean.winRate)
      f.push(b.motor - mean.motor)
      f.push((b.exhibition - mean.exhibition) * 10)
      // ★条件 × 内寄り度
      for (const c of CONDS) f.push(cv[c] * innerness(b.course) * 10)
      return f
    })
    const order = raw.map((b, i) => [b.rank, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    data.push({ X, order })
  }
  return data
}

const score = (x, W, st) => { let v = 0; for (let k = 0; k < NF; k++) v += W[st * NF + k] * x[k]; return v }

function llOf(data, W) {
  let ll = 0
  for (const d of data) {
    for (let step = 0; step < 5; step++) {
      const st = stageOf(step)
      const rem = d.order.slice(step)
      const s = rem.map((i) => score(d.X[i], W, st))
      const mx = Math.max(...s)
      let z = 0
      for (const v of s) z += Math.exp(v - mx)
      ll += s[0] - (mx + Math.log(z))
    }
  }
  return ll / data.length
}

function train(data, l2) {
  const W = new Float64Array(NW)
  const m = new Float64Array(NW), v = new Float64Array(NW)
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, alpha = 0.05
  for (let t = 1; t <= 400; t++) {
    const grad = new Float64Array(NW)
    for (const d of data) {
      for (let step = 0; step < 5; step++) {
        const st = stageOf(step)
        const rem = d.order.slice(step)
        const s = rem.map((i) => score(d.X[i], W, st))
        const mx = Math.max(...s)
        let z = 0
        for (const val of s) z += Math.exp(val - mx)
        for (let j = 0; j < rem.length; j++) {
          const p = Math.exp(s[j] - mx) / z
          const coef = (j === 0 ? 1 : 0) - p
          const x = d.X[rem[j]]
          for (let k = 0; k < NF; k++) grad[st * NF + k] += coef * x[k]
        }
      }
    }
    for (let k = 0; k < NW; k++) {
      grad[k] -= 2 * l2 * W[k]
      m[k] = b1 * m[k] + (1 - b1) * grad[k]
      v[k] = b2 * v[k] + (1 - b2) * grad[k] * grad[k]
      W[k] += alpha * (m[k] / (1 - b1 ** t)) / (Math.sqrt(v[k] / (1 - b2 ** t)) + eps)
    }
  }
  return W
}

function evaluate(data, W, label) {
  let top1 = 0, tri = 0
  for (const d of data) {
    const pick = []
    let pool = d.X.map((_, i) => i)
    for (let step = 0; step < 3; step++) {
      const st = stageOf(step)
      let bi = pool[0], bs = -Infinity
      for (const i of pool) { const v = score(d.X[i], W, st); if (v > bs) { bs = v; bi = i } }
      pick.push(bi); pool = pool.filter((i) => i !== bi)
    }
    if (pick[0] === d.order[0]) top1++
    if (pick[0] === d.order[0] && pick[1] === d.order[1] && pick[2] === d.order[2]) tri++
  }
  const n = data.length
  const ll = llOf(data, W)
  console.log(`[${label}] n=${n}  対数尤度/レース ${ll.toFixed(4)}  1着的中 ${((top1 / n) * 100).toFixed(1)}%  3連単1点 ${((tri / n) * 100).toFixed(1)}%`)
  return { ll, top1: top1 / n, tri: tri / n }
}

// ---------- 実行 ----------
console.log(`=== Plackett-Luce v3 ===`)
console.log(`条件: ${CONDS.length ? CONDS.join(', ') : '（なし＝v2相当）'}`)
console.log(`特徴量${NF} × 段階${NSTAGE} = 重み${NW}個\n`)

const st = buildStats(VALID)
console.log('学習期間で測った条件値（1コース1着率 − 全体平均）:')
for (const c of CONDS) {
  const e = Object.entries(st.cond[c]).sort((a, b) => b[1] - a[1])
  if (!e.length) continue
  const top = e.slice(0, 3).map(([k, v]) => `${k}:${(v * 100).toFixed(1)}pt`).join(' ')
  const bot = e.slice(-3).map(([k, v]) => `${k}:${(v * 100).toFixed(1)}pt`).join(' ')
  console.log(`  ${c.padEnd(8)} 高← ${top}  ／  低← ${bot}`)
}

const trainData = buildDataset(st, '2000-01-01', VALID)
const validData = buildDataset(st, VALID, SPLIT)
const testData = buildDataset(st, SPLIT, '2100-01-01')
console.log(`\n学習 ${trainData.length} / 検証用 ${validData.length} / 最終評価 ${testData.length}\n`)

let best = { l2: null, ll: -Infinity, W: null }
for (const l2 of [1, 3, 10, 30]) {
  const W = train(trainData, l2)
  const ll = llOf(validData, W)
  console.log(`  L2=${String(l2).padStart(3)}  検証用 ${ll.toFixed(4)}`)
  if (ll > best.ll) best = { l2, ll, W }
}
console.log(`\n→ L2 = ${best.l2}\n`)

const names = ['1着選び', '2着選び', '3着以降']
for (let s = 0; s < NSTAGE; s++) {
  const condW = CONDS.map((c, i) => {
    const idx = FEATURES.indexOf(`cond_${c}`)
    return `${c}:${best.W[s * NF + idx] >= 0 ? '+' : ''}${best.W[s * NF + idx].toFixed(3)}`
  })
  console.log(`${names[s]} の条件の重み: ${condW.join('  ')}`)
}
console.log('')
evaluate(trainData, best.W, '学習期間')
evaluate(validData, best.W, '検証用')
const te = evaluate(testData, best.W, '★最終評価（未知）')

writeFileSync(join(ROOT, 'data', `model3${OFF.size ? '-off-' + [...OFF].join('_') : ''}.json`),
  JSON.stringify({ features: FEATURES, stages: NSTAGE, weights: [...best.W], l2: best.l2, conds: CONDS, testScore: te }, null, 2))
db.close()
