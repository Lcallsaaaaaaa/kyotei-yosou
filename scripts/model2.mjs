// Plackett-Luce v2：着順の段階ごとに重みを変える（stage-varying coefficients）。
//
//   node scripts/model2.mjs --split 2026-02-18 --valid 2026-01-01
//   node scripts/model2.mjs --stages 1     段階分けを無効化（v1相当・比較用）
//
// ★v1の構造的な弱点
//   各艇に「強さ」を1つだけ与えるモデルでは、
//     P(1着) が低い ⇒ P(2着) も低い
//   としか表現できない。だが実際には
//     「1着は取れないが確実に2・3着に来る」（例：児島12R 若狭奈美子 2コース1着率15%・3連対率94%）
//   というタイプが存在し、これは1つの強さでは表せない。
//
// ★v2の対処
//   ① 1着率・2着率・3着率を**別々の特徴量**として持つ
//   ② 「1着を選ぶ段階」「2着を選ぶ段階」「3着以降」で**重みを別に学習する**
//   これで「1着選びでは効かないが2着選びでは効く」特徴量を表現できる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const SPLIT = flag('split', '2026-02-18')
const VALID = flag('valid', '2026-01-01')
const NSTAGE = Number(flag('stages', 3)) // 1なら段階分けなし（v1相当）
const stageOf = (step) => (NSTAGE === 1 ? 0 : Math.min(step, NSTAGE - 1))

const K = 25
const shrink = (h, n, prior) => (h + K * prior) / (n + K)

const FEATURES = [
  'course2', 'course3', 'course4', 'course5', 'course6',
  'racerP1',   // そのコースでの1着率
  'racerP2',   // ★追加：2着率
  'racerP3',   // ★追加：3着率
  'racerST',   // 平均ST（符号反転）
  'venueBase',
  'grade', 'winRate', 'motor', 'exhibition',
]
const NF = FEATURES.length
const GRADE = { A1: 3, A2: 2, B1: 1, B2: 0 }

function buildStats(cutoff) {
  const venueBase = {}
  for (const r of all(`SELECT r.jcd, e.course c, COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY r.jcd, e.course`, cutoff))
    venueBase[`${r.jcd}:${r.c}`] = r.w / r.n

  const courseBase = {}
  for (const r of all(`SELECT e.course c, COUNT(*) n,
      SUM(e.rank_num=1) p1, SUM(e.rank_num=2) p2, SUM(e.rank_num=3) p3,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY e.course`, cutoff))
    courseBase[r.c] = { p1: r.p1 / r.n, p2: r.p2 / r.n, p3: r.p3 / r.n, st: r.st }

  const racer = new Map()
  for (const r of all(`SELECT e.racer_id, e.course c, COUNT(*) n,
      SUM(e.rank_num=1) p1, SUM(e.rank_num=2) p2, SUM(e.rank_num=3) p3,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND e.racer_id IS NOT NULL AND r.date < ?
    GROUP BY e.racer_id, e.course`, cutoff))
    racer.set(`${r.racer_id}:${r.c}`, r)
  return { venueBase, courseBase, racer }
}

function buildDataset(stats, fromDate, toDate) {
  const rows = all(`
    SELECT e.race_id, r.jcd, e.lane, e.course, e.rank_num, e.racer_id, e.exhibition,
           p.grade, p.win_rate_nat, p.motor_top2
    FROM entries e JOIN races r ON r.race_id = e.race_id
    LEFT JOIN programs p ON p.race_id = e.race_id AND p.lane = e.lane
    WHERE r.date >= ? AND r.date < ? AND e.course IS NOT NULL AND e.rank_num IS NOT NULL`,
    fromDate, toDate)

  const byRace = new Map()
  for (const r of rows) {
    if (!byRace.has(r.race_id)) byRace.set(r.race_id, [])
    byRace.get(r.race_id).push(r)
  }

  const data = []
  for (const [race_id, boats] of byRace) {
    if (boats.length !== 6) continue
    if (new Set(boats.map((b) => b.rank_num)).size !== 6) continue
    if (boats.some((b) => b.exhibition == null)) continue

    const raw = boats.map((b) => {
      const cb = stats.courseBase[b.course]
      const rs = stats.racer.get(`${b.racer_id}:${b.course}`) ?? { n: 0, p1: 0, p2: 0, p3: 0, st: null }
      return {
        course: b.course, rank: b.rank_num,
        racerP1: shrink(rs.p1, rs.n, cb.p1),
        racerP2: shrink(rs.p2, rs.n, cb.p2),
        racerP3: shrink(rs.p3, rs.n, cb.p3),
        racerST: -(rs.st ?? cb.st),
        venueBase: stats.venueBase[`${b.jcd}:${b.course}`] ?? cb.p1,
        grade: GRADE[b.grade] ?? 1,
        winRate: b.win_rate_nat ?? 5,
        motor: (b.motor_top2 ?? 33) / 100,
        exhibition: -b.exhibition,
      }
    })
    const cen = ['racerP1', 'racerP2', 'racerP3', 'racerST', 'grade', 'winRate', 'motor', 'exhibition']
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
      f.push(b.grade - mean.grade)
      f.push(b.winRate - mean.winRate)
      f.push(b.motor - mean.motor)
      f.push((b.exhibition - mean.exhibition) * 10)
      return f
    })
    const order = raw.map((b, i) => [b.rank, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    data.push({ X, order })
  }
  return data
}

const NW = NSTAGE * NF
const score = (x, W, st) => { let v = 0; for (let k = 0; k < NF; k++) v += W[st * NF + k] * x[k]; return v }

function logLikAndGrad(data, W, l2) {
  let ll = 0
  const grad = new Float64Array(NW)
  for (const d of data) {
    for (let step = 0; step < 5; step++) {
      const st = stageOf(step)
      const remain = d.order.slice(step)
      const s = remain.map((i) => score(d.X[i], W, st))
      const mx = Math.max(...s)
      let z = 0
      for (const v of s) z += Math.exp(v - mx)
      ll += s[0] - (mx + Math.log(z)) // remain[0] は実際に選ばれた艇
      for (let j = 0; j < remain.length; j++) {
        const p = Math.exp(s[j] - mx) / z
        const coef = (j === 0 ? 1 : 0) - p
        const x = d.X[remain[j]]
        for (let k = 0; k < NF; k++) grad[st * NF + k] += coef * x[k]
      }
    }
  }
  for (let k = 0; k < NW; k++) { ll -= l2 * W[k] * W[k]; grad[k] -= 2 * l2 * W[k] }
  return { ll, grad }
}

function train(data, { iters = 400, l2 = 3 } = {}) {
  const W = new Float64Array(NW)
  const m = new Float64Array(NW), v = new Float64Array(NW)
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, alpha = 0.05
  for (let t = 1; t <= iters; t++) {
    const { grad } = logLikAndGrad(data, W, l2)
    for (let k = 0; k < NW; k++) {
      m[k] = b1 * m[k] + (1 - b1) * grad[k]
      v[k] = b2 * v[k] + (1 - b2) * grad[k] * grad[k]
      W[k] += alpha * (m[k] / (1 - b1 ** t)) / (Math.sqrt(v[k] / (1 - b2 ** t)) + eps)
    }
  }
  return W
}

function evaluate(data, W, label) {
  let ll = 0, top1 = 0, tri = 0
  for (const d of data) {
    for (let step = 0; step < 5; step++) {
      const st = stageOf(step)
      const remain = d.order.slice(step)
      const s = remain.map((i) => score(d.X[i], W, st))
      const mx = Math.max(...s)
      let z = 0
      for (const val of s) z += Math.exp(val - mx)
      ll += s[0] - (mx + Math.log(z))
    }
    // 予測順位：段階ごとに貪欲に選ぶ
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
  console.log(`[${label}]  n=${n}  対数尤度/レース ${(ll / n).toFixed(4)}  1着的中 ${((top1 / n) * 100).toFixed(1)}%  3連単1点的中 ${((tri / n) * 100).toFixed(1)}%`)
  return { ll: ll / n, top1: top1 / n, tri: tri / n }
}

// ---------- 実行 ----------
console.log(`=== Plackett-Luce v2 ===`)
console.log(`特徴量(${NF}) × 段階(${NSTAGE}) = 重み${NW}個`)
console.log(`段階分け: ${NSTAGE === 1 ? 'なし（v1相当）' : '1着選び / 2着選び / 3着以降 で別々に学習'}\n`)

const stats = buildStats(VALID)
const trainData = buildDataset(stats, '2000-01-01', VALID)
const validData = buildDataset(stats, VALID, SPLIT)
const testData = buildDataset(stats, SPLIT, '2100-01-01')
console.log(`学習 ${trainData.length} / 検証用 ${validData.length} / 最終評価 ${testData.length}\n`)

let best = { l2: null, ll: -Infinity, W: null }
for (const l2 of [1, 3, 10, 30, 100]) {
  const W = train(trainData, { l2 })
  let ll = 0
  for (const d of validData) {
    for (let step = 0; step < 5; step++) {
      const st = stageOf(step)
      const remain = d.order.slice(step)
      const s = remain.map((i) => score(d.X[i], W, st))
      const mx = Math.max(...s)
      let z = 0
      for (const val of s) z += Math.exp(val - mx)
      ll += s[0] - (mx + Math.log(z))
    }
  }
  ll /= validData.length
  console.log(`  L2=${String(l2).padStart(4)}  検証用 ${ll.toFixed(4)}`)
  if (ll > best.ll) best = { l2, ll, W }
}
console.log(`\n→ L2 = ${best.l2} を採用\n`)

const names = NSTAGE === 1 ? ['全段階'] : ['1着選び', '2着選び', '3着以降']
for (let st = 0; st < NSTAGE; st++) {
  console.log(`=== ${names[st]} の重み ===`)
  FEATURES.map((f, i) => [f, best.W[st * NF + i]])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8)
    .forEach(([f, v]) => console.log(`  ${f.padEnd(11)} ${v >= 0 ? '+' : ''}${v.toFixed(4)}`))
  console.log('')
}

evaluate(trainData, best.W, '学習期間')
evaluate(validData, best.W, '検証用')
const te = evaluate(testData, best.W, '★最終評価（未知）')

writeFileSync(join(ROOT, 'data', `model2-s${NSTAGE}.json`), JSON.stringify({
  features: FEATURES, stages: NSTAGE, weights: [...best.W], l2: best.l2, split: SPLIT, valid: VALID, testScore: te,
}, null, 2))
db.close()
