// Plackett-Luce（順位付きロジット）で着順確率モデルを学習・評価する。
//
//   node scripts/model.mjs train              学習して data/model.json に保存
//   node scripts/model.mjs train --no-exhibition   展示タイム抜き（朝の予想用）
//   node scripts/model.mjs eval               保存済みモデルを検証期間で評価
//
// ★なぜ Plackett-Luce か
//   各艇に強さ s_i を与え、1着は softmax(s)、2着は残りの softmax… と順に選ばれるとみなす。
//   競走のような「順位が観測されるデータ」に対する標準的な確率モデルで、
//   **全120通りの着順に整合した確率を与えられる**。
//   いまの手組みモデルは「1着＝1号艇」の場合しか扱えず、残り約8割の決着が構造的に盲点だった。
//
// ★特徴量の設計方針
//   - レース内で中心化できるものは中心化する（絶対値でなく「そのレースでの相対」が効くため）
//   - 予想時点で入手できるものだけを使う。**本番STは使わない**（レース後にしか分からない）
//   - 代わりに「選手の平均ST実績」を入れる。STは選手の技量なので過去実績で代理できる

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'train'
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const SPLIT = flag('split', '2026-02-18')
const USE_EX = !argv.includes('--no-exhibition')
const MODEL_PATH = join(ROOT, 'data', USE_EX ? 'model.json' : 'model-noex.json')

const K = 25
const shrink = (h, n, prior) => (h + K * prior) / (n + K)

// ---------- 特徴量の名前（重みの解釈に使う） ----------
const FEATURES = [
  'course2', 'course3', 'course4', 'course5', 'course6', // 1コースを基準にしたダミー
  'racerWin',      // 選手のそのコースでの1着率（縮小・レース内中心化）
  'racerTop3',     // 同 3連対率
  'racerST',       // 選手のそのコースでの平均ST（速いほど大きくなるよう符号反転・中心化）
  // ★幾何学的特徴量（geometry.mjs の実測を特徴量に落としたもの）
  // 実測：1コースに対し外が +0.057秒(0.9m) 先行すると1コース1着率は50%、
  //       +0.145秒(2.3m) では17.9% まで落ちる。ST差は最大の説明変数。
  // 本番STは予想時点で不明なので、選手のコース別ST実績から「期待ST差」を組む。
  'stEdge',        // 内側艇の期待STの最小値 − 自艇の期待ST（正なら自分が先行）
  'stSD',          // 選手のSTのばらつき（符号反転＝安定しているほど大きい）
  'venueBase',     // 場×コースの1着率ベースレート
  'grade',         // 級別 A1=3 A2=2 B1=1 B2=0（中心化）
  'winRate',       // 全国勝率（中心化）
  'motor',         // モーター2連率（中心化）
  ...(USE_EX ? ['exhibition'] : []), // 展示タイム（速いほど大きい・中心化）
]
const NF = FEATURES.length

// ---------- 学習期間から選手・場の統計を作る ----------
function buildStats(cutoff) {
  const venueBase = {} // `${jcd}:${course}` -> 1着率
  for (const r of all(`SELECT r.jcd, e.course c, COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY r.jcd, e.course`, cutoff)) {
    venueBase[`${r.jcd}:${r.c}`] = r.w / r.n
  }
  const courseBase = {} // course -> 全国平均
  for (const r of all(`SELECT e.course c, COUNT(*) n, SUM(e.rank_num=1) w, SUM(e.rank_num<=3) t3,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY e.course`, cutoff)) {
    courseBase[r.c] = { win: r.w / r.n, top3: r.t3 / r.n, st: r.st }
  }
  const racer = new Map() // `${racer_id}:${course}` -> {n, win, top3, st, stSD}
  for (const r of all(`SELECT e.racer_id, e.course c, COUNT(*) n, SUM(e.rank_num=1) w,
      SUM(e.rank_num<=3) t3,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st*e.st END) st2,
      SUM(CASE WHEN e.st_flag IS NULL THEN 1 ELSE 0 END) stn
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND e.racer_id IS NOT NULL AND r.date < ?
    GROUP BY e.racer_id, e.course`, cutoff)) {
    // 分散 = E[x^2] - E[x]^2。標本が薄いとノイズなので下限を置く
    const varSt = r.st != null && r.st2 != null ? Math.max(0, r.st2 - r.st * r.st) : null
    racer.set(`${r.racer_id}:${r.c}`, {
      n: r.n, w: r.w, t3: r.t3, st: r.st,
      stSD: varSt != null && r.stn >= 5 ? Math.sqrt(varSt) : null,
    })
  }
  // ST関連の全国平均（欠損時のフォールバック）
  const stSDBase = {}
  for (const r of all(`SELECT e.course c,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) st,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st*e.st END) st2
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL AND r.date < ? GROUP BY e.course`, cutoff)) {
    stSDBase[r.c] = Math.sqrt(Math.max(0, r.st2 - r.st * r.st))
  }
  return { venueBase, courseBase, racer, stSDBase }
}

// ---------- レースを特徴量行列に変換 ----------
const GRADE = { A1: 3, A2: 2, B1: 1, B2: 0 }

function buildDataset(stats, fromDate, toDate) {
  const rows = all(`
    SELECT e.race_id, r.jcd, e.lane, e.course, e.rank_num, e.racer_id, e.exhibition,
           p.grade, p.win_rate_nat, p.motor_top2
    FROM entries e
    JOIN races r ON r.race_id = e.race_id
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
    if (new Set(boats.map((b) => b.rank_num)).size !== 6) continue // 完走6艇のみ
    if (USE_EX && boats.some((b) => b.exhibition == null)) continue

    const raw = boats.map((b) => {
      const cb = stats.courseBase[b.course] ?? { win: 0.16, top3: 0.5, st: 0.16 }
      const rs = stats.racer.get(`${b.racer_id}:${b.course}`) ?? { n: 0, w: 0, t3: 0, st: null }
      return {
        course: b.course,
        rank: b.rank_num,
        racerWin: shrink(rs.w, rs.n, cb.win),
        racerTop3: shrink(rs.t3, rs.n, cb.top3),
        // STは「小さいほど良い」ので符号反転して「大きいほど良い」に揃える
        racerST: -(rs.st ?? cb.st),
        expST: rs.st ?? cb.st, // 期待ST（幾何計算用・符号はそのまま）
        stSD: -(rs.stSD ?? stats.stSDBase[b.course] ?? 0.04),
        venueBase: stats.venueBase[`${b.jcd}:${b.course}`] ?? cb.win,
        grade: GRADE[b.grade] ?? 1,
        winRate: b.win_rate_nat ?? 5,
        motor: (b.motor_top2 ?? 33) / 100,
        exhibition: b.exhibition == null ? 0 : -b.exhibition,
      }
    })

    // ★幾何：内側艇の期待STの最小値と自艇の差。正なら自分が先行する見込み。
    // 1コースには内側が無いので、外側最速との差の符号を反転して同じ意味に揃える。
    const byCourse = Object.fromEntries(raw.map((b) => [b.course, b]))
    for (const b of raw) {
      if (b.course === 1) {
        let outerMin = Infinity
        for (let c = 2; c <= 6; c++) outerMin = Math.min(outerMin, byCourse[c].expST)
        b.stEdge = outerMin - b.expST
      } else {
        let innerMin = Infinity
        for (let i = 1; i < b.course; i++) innerMin = Math.min(innerMin, byCourse[i].expST)
        b.stEdge = innerMin - b.expST
      }
    }

    // レース内で中心化する項目（「そのレースでの相対」が効くため）
    const centered = ['racerWin', 'racerTop3', 'racerST', 'stEdge', 'stSD', 'grade', 'winRate', 'motor', 'exhibition']
    const mean = {}
    for (const k of centered) mean[k] = raw.reduce((a, b) => a + b[k], 0) / raw.length

    const X = raw.map((b) => {
      const f = []
      for (let c = 2; c <= 6; c++) f.push(b.course === c ? 1 : 0)
      f.push(b.racerWin - mean.racerWin)
      f.push(b.racerTop3 - mean.racerTop3)
      f.push((b.racerST - mean.racerST) * 10) // STは単位が小さいのでスケールを揃える
      f.push((b.stEdge - mean.stEdge) * 10)     // 幾何：期待ST差
      f.push((b.stSD - mean.stSD) * 10)         // ST安定性
      f.push(b.venueBase)
      f.push(b.grade - mean.grade)
      f.push(b.winRate - mean.winRate)
      f.push(b.motor - mean.motor)
      if (USE_EX) f.push((b.exhibition - mean.exhibition) * 10)
      return f
    })
    const order = raw.map((b, i) => [b.rank, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    data.push({ race_id, X, order, courses: raw.map((b) => b.course) })
  }
  return data
}

// ---------- Plackett-Luce の対数尤度と勾配 ----------
function logLikAndGrad(data, w, l2) {
  let ll = 0
  const grad = new Float64Array(NF)
  for (const d of data) {
    const s = d.X.map((x) => { let v = 0; for (let k = 0; k < NF; k++) v += w[k] * x[k]; return v })
    // 上位5着ぶん順に選ばれる確率をかけ合わせる（6着は自動で決まる）
    for (let step = 0; step < 5; step++) {
      const remain = d.order.slice(step)
      const mx = Math.max(...remain.map((i) => s[i]))
      let z = 0
      for (const i of remain) z += Math.exp(s[i] - mx)
      const chosen = d.order[step]
      ll += s[chosen] - (mx + Math.log(z))
      for (const i of remain) {
        const p = Math.exp(s[i] - mx) / z
        const coef = (i === chosen ? 1 : 0) - p
        for (let k = 0; k < NF; k++) grad[k] += coef * d.X[i][k]
      }
    }
  }
  for (let k = 0; k < NF; k++) { ll -= l2 * w[k] * w[k]; grad[k] -= 2 * l2 * w[k] }
  return { ll, grad }
}

function quickLL(data, w) {
  let ll = 0
  for (const d of data) {
    const s = d.X.map((x) => { let v = 0; for (let k = 0; k < NF; k++) v += w[k] * x[k]; return v })
    for (let step = 0; step < 5; step++) {
      const remain = d.order.slice(step)
      const mx = Math.max(...remain.map((i) => s[i]))
      let z = 0
      for (const i of remain) z += Math.exp(s[i] - mx)
      ll += s[d.order[step]] - (mx + Math.log(z))
    }
  }
  return ll / data.length
}

function train(data, { iters = 400, l2 = 3, quiet = false } = {}) {
  let w = new Float64Array(NF)
  // Adam（学習率の自動調整）。素の勾配上昇だと特徴量ごとのスケール差で収束しない
  const mAdam = new Float64Array(NF)
  const vAdam = new Float64Array(NF)
  const b1 = 0.9, b2 = 0.999, eps = 1e-8
  const alpha = 0.05
  let prev = -Infinity
  for (let t = 1; t <= iters; t++) {
    const { ll, grad } = logLikAndGrad(data, w, l2)
    for (let k = 0; k < NF; k++) {
      mAdam[k] = b1 * mAdam[k] + (1 - b1) * grad[k]
      vAdam[k] = b2 * vAdam[k] + (1 - b2) * grad[k] * grad[k]
      const mh = mAdam[k] / (1 - Math.pow(b1, t))
      const vh = vAdam[k] / (1 - Math.pow(b2, t))
      w[k] += alpha * mh / (Math.sqrt(vh) + eps)
    }
    if (!quiet && (t % 200 === 0 || t === 1)) {
      console.log(`  iter ${String(t).padStart(4)}  logLik/race ${(ll / data.length).toFixed(4)}`)
    }
    if (Math.abs(ll - prev) < 1e-6 * Math.abs(prev)) break
    prev = ll
  }
  return w
}

// ---------- 評価 ----------
function evaluate(data, w, label) {
  let ll = 0, top1 = 0, tri = 0
  for (const d of data) {
    const s = d.X.map((x) => { let v = 0; for (let k = 0; k < NF; k++) v += w[k] * x[k]; return v })
    for (let step = 0; step < 5; step++) {
      const remain = d.order.slice(step)
      const mx = Math.max(...remain.map((i) => s[i]))
      let z = 0
      for (const i of remain) z += Math.exp(s[i] - mx)
      ll += s[d.order[step]] - (mx + Math.log(z))
    }
    const best = s.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])
    if (best[0][1] === d.order[0]) top1++
    if (best[0][1] === d.order[0] && best[1][1] === d.order[1] && best[2][1] === d.order[2]) tri++
  }
  const n = data.length
  console.log(`\n[${label}]  n=${n}`)
  console.log(`  対数尤度/レース : ${(ll / n).toFixed(4)}  （高いほど良い。完全ランダムは ${(-(Math.log(6)+Math.log(5)+Math.log(4)+Math.log(3)+Math.log(2))).toFixed(4)}）`)
  console.log(`  1着的中率       : ${((top1 / n) * 100).toFixed(1)}%`)
  console.log(`  3連単1点的中率  : ${((tri / n) * 100).toFixed(1)}%`)
  return { ll: ll / n, top1: top1 / n, tri: tri / n }
}

// ---------- 実行 ----------
if (cmd === 'train') {
  console.log(`=== Plackett-Luce 学習 ===`)
  console.log(`特徴量(${NF}): ${FEATURES.join(', ')}`)
  console.log(`展示タイム: ${USE_EX ? '使う（直前用）' : '使わない（朝の予想用）'}\n`)

  // ★3分割：学習 → 検証用（L2の選択）→ 最終評価
  // 正則化の強さを最終評価データで選ぶと、そのデータに合わせ込むことになり数字が嘘になる。
  const VALID = flag('valid', '2026-01-01')
  const stats = buildStats(VALID)
  const trainData = buildDataset(stats, '2000-01-01', VALID)
  const validData = buildDataset(stats, VALID, SPLIT)
  const testData = buildDataset(stats, SPLIT, '2100-01-01')
  console.log(`学習 ${trainData.length} / 検証用 ${validData.length} / 最終評価 ${testData.length} レース\n`)

  console.log('L2（正則化の強さ）を検証用データで選ぶ:')
  let best = { l2: null, ll: -Infinity, w: null }
  for (const l2 of [0.3, 1, 3, 10, 30]) {
    const wc = train(trainData, { iters: 400, l2, quiet: true })
    const ll = quickLL(validData, wc)
    console.log(`  L2=${String(l2).padStart(4)}  検証用の対数尤度/レース ${ll.toFixed(4)}`)
    if (ll > best.ll) best = { l2, ll, w: wc }
  }
  console.log(`\n→ L2 = ${best.l2} を採用\n`)
  const w = best.w

  console.log('\n=== 学習された重み（大きいほど勝ちに寄与）===')
  FEATURES.map((f, i) => [f, w[i]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .forEach(([f, v]) => console.log(`  ${f.padEnd(12)} ${v >= 0 ? '+' : ''}${v.toFixed(4)}`))

  evaluate(trainData, w, '学習期間')
  evaluate(validData, w, '検証用')
  const te = evaluate(testData, w, '検証期間（未知データ）')

  writeFileSync(MODEL_PATH, JSON.stringify({
    features: FEATURES, weights: [...w], split: SPLIT, useExhibition: USE_EX,
    trainedOn: trainData.length, testScore: te,
  }, null, 2))
  console.log(`\n保存: ${MODEL_PATH}`)
} else if (cmd === 'eval') {
  const m = JSON.parse(readFileSync(MODEL_PATH, 'utf8'))
  const stats = buildStats(m.split)
  const testData = buildDataset(stats, m.split, '2100-01-01')
  evaluate(testData, Float64Array.from(m.weights), '検証期間')
}
db.close()
