// レースの買い判断を、確率の「不確実性」まで含めて出す。
//
//   node scripts/ev.mjs --jcd 16 --race 12 --date 2026-08-18 --lanes 4482,4373,4825,4938,5193,4964
//   node scripts/ev.mjs --jcd 16 --race 12 --date 2026-08-18   （DBに番組表があれば登番は自動）
//
// ★これまでの問題
//   EV = 推定確率 × オッズ で判断していたが、**推定確率が点推定だった**。
//   2026/08/18 児島12R は EV1.6 が出ていたが、その確率の裏付けは
//   「若狭の逃がし2着率 n=19」といった薄い標本。EVの数字だけ見ると買いに見える。
//
// ★対処
//   階層ベイズで推定した事前（data/shrinkage.json）を使い、各確率をベータ事後分布として扱う。
//   そこからモンテカルロで出目確率を何千回もサンプリングし、**EVの分布**を出す。
//   買うのは「EVの下限（25パーセンタイル）が1.0を超える」ときだけにする。
//   平均EVが高くても、ばらつきが大きければ見送る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const jcd = Number(flag('jcd'))
const raceNo = Number(flag('race'))
const date = flag('date')
const NSIM = Number(flag('sim', 4000))
if (!jcd || !raceNo || !date) {
  console.error('使い方: node scripts/ev.mjs --jcd 16 --race 12 --date 2026-08-18 [--lanes 登番6つ]')
  process.exit(1)
}
const raceId = `${date.replace(/-/g, '')}-${String(jcd).padStart(2, '0')}-${String(raceNo).padStart(2, '0')}`

// 登番：引数があればそれ、無ければ番組表から
let lanes = flag('lanes')?.split(',').map(Number)
if (!lanes) {
  const rows = all(`SELECT lane, racer_id, racer_name FROM programs WHERE race_id=? ORDER BY lane`, raceId)
  if (rows.length !== 6) { console.error(`${raceId} の番組表がDBにありません。--lanes で登番6つを指定してください。`); process.exit(1) }
  lanes = rows.map((r) => r.racer_id)
}
const names = Object.fromEntries(
  all(`SELECT lane, racer_name FROM programs WHERE race_id=? ORDER BY lane`, raceId).map((r) => [r.lane, r.racer_name]))

const SH = JSON.parse(readFileSync(join(ROOT, 'data', 'shrinkage.json'), 'utf8'))
const calibrate = (p) => Math.max(0.02, Math.min(0.97, 1.478 * p - 0.286))

// --- ベータ分布からのサンプリング（ガンマ2つの比）---
function randGamma(k) {
  if (k < 1) return randGamma(k + 1) * Math.pow(Math.random(), 1 / k)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x, v
    do { const u1 = Math.random(), u2 = Math.random()
         x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
         v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
const randBeta = (a, b) => { const x = randGamma(a); return x / (x + randGamma(b)) }

// --- 場のベースレートと「1コース1着レース」に限った各コースの2/3着率 ---
db.exec('DROP TABLE IF EXISTS temp.w1')
db.prepare(`CREATE TEMP TABLE w1 AS SELECT e.race_id FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course=1 AND e.rank_num=1 AND r.jcd=?`).run(jcd)
db.exec('CREATE INDEX temp.idx_w1 ON w1(race_id)')

const vIn = one(`SELECT COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.course=1 AND r.jcd=?`, jcd)
const venueIn = vIn.w / vIn.n
const vNg = {}
for (const r of all(`SELECT e.course c, COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
  FROM entries e JOIN w1 ON w1.race_id=e.race_id WHERE e.course BETWEEN 2 AND 6 GROUP BY e.course`))
  vNg[r.c] = { p2: r.s2 / r.n, p3: r.s3 / r.n }

// --- 各艇の観測（全場） ---
db.exec('DROP TABLE IF EXISTS temp.w1n')
db.exec(`CREATE TEMP TABLE w1n AS SELECT race_id FROM entries WHERE course=1 AND rank_num=1`)
db.exec('CREATE INDEX temp.idx_w1n ON w1n(race_id)')

const obs1 = one(`SELECT COUNT(*) n, SUM(rank_num=1) w FROM entries WHERE racer_id=? AND course=1`, lanes[0])
const obsNg = []
for (let c = 2; c <= 6; c++) {
  obsNg.push(one(`SELECT COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
    FROM entries e JOIN w1n w ON w.race_id=e.race_id WHERE e.racer_id=? AND e.course=?`, lanes[c - 1], c))
}

const K1 = SH['1着率']['1'].K
const K2 = (c) => SH['2着率'][String(c)].K
const K3 = (c) => SH['3着率'][String(c)].K

console.log(`=== ${date} jcd=${jcd} ${raceNo}R  買い判断（不確実性つき）===\n`)
console.log(`1号艇 ${names[1] ?? lanes[0]}  1コース ${obs1.n}走${obs1.w}勝   縮小K=${K1.toFixed(0)}（階層ベイズ推定・旧固定値25）`)
console.log(`各艇の逃がし実績: ${obsNg.map((o, i) => `${i + 2}号艇 n=${o.n}`).join(' / ')}\n`)

// --- モンテカルロ：確率を事後分布から引いて出目確率の分布を作る ---
const combos = new Map()
for (let s = 2; s <= 6; s++) for (let t = 2; t <= 6; t++) if (s !== t) combos.set(`1-${s}-${t}`, [])
const pInSamples = []

for (let it = 0; it < NSIM; it++) {
  // 1着率：Beta(α+k, β+n−k)
  const a1 = K1 * venueIn + obs1.w
  const b1 = K1 * (1 - venueIn) + (obs1.n - obs1.w)
  const pIn = calibrate(randBeta(a1, b1))
  pInSamples.push(pIn)

  const p2 = [], p3 = []
  for (let c = 2; c <= 6; c++) {
    const o = obsNg[c - 2]
    const v = vNg[c] ?? { p2: 0.2, p3: 0.2 }
    const k2 = K2(c), k3 = K3(c)
    p2[c] = randBeta(k2 * v.p2 + o.s2, k2 * (1 - v.p2) + (o.n - o.s2))
    p3[c] = randBeta(k3 * v.p3 + o.s3, k3 * (1 - v.p3) + (o.n - o.s3))
  }
  const sum2 = [2, 3, 4, 5, 6].reduce((a, c) => a + p2[c], 0)
  for (let s = 2; s <= 6; s++) {
    const deme = pIn * (p2[s] / sum2)
    const rest = [2, 3, 4, 5, 6].filter((c) => c !== s)
    const s3 = rest.reduce((a, c) => a + p3[c], 0)
    for (const t of rest) combos.get(`1-${s}-${t}`).push(deme * (p3[t] / s3))
  }
}

const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))] }
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length

console.log(`1着率（1号艇の逃げ）  平均 ${(mean(pInSamples) * 100).toFixed(1)}%   80%区間 ${(q(pInSamples, 0.1) * 100).toFixed(1)}% 〜 ${(q(pInSamples, 0.9) * 100).toFixed(1)}%`)

// --- オッズと突き合わせ ---
const odds = Object.fromEntries(all(`SELECT combo, odds FROM odds3t WHERE race_id=?`, raceId).map((r) => [r.combo, r.odds]))
const hasOdds = Object.keys(odds).length > 0

const rows = [...combos.entries()].map(([combo, arr]) => {
  const o = odds[combo] ?? null
  return {
    combo, pMean: mean(arr), pLo: q(arr, 0.25), pHi: q(arr, 0.75), odds: o,
    evMean: o ? mean(arr) * o : null,
    evLo: o ? q(arr, 0.25) * o : null,   // ★保守的なEV（下側25%）
  }
}).sort((a, b) => (b.evMean ?? -1) - (a.evMean ?? -1))

if (!hasOdds) {
  console.log(`\n⚠️ このレースのオッズが未収集です（node scripts/odds.mjs --from ${date} --to ${date}）。確率だけ表示します。\n`)
  console.log('出目      推定確率      50%区間')
  for (const r of rows.slice(0, 10))
    console.log(`  ${r.combo}   ${(r.pMean * 100).toFixed(1)}%    ${(r.pLo * 100).toFixed(1)}%〜${(r.pHi * 100).toFixed(1)}%`)
} else {
  console.log(`\n出目      確率(平均)   50%区間        オッズ   EV(平均)  ★EV下限   判定`)
  for (const r of rows.slice(0, 12)) {
    const buy = r.evLo !== null && r.evLo >= 1.0
    console.log(
      `  ${r.combo}   ${(r.pMean * 100).toFixed(1)}%     ` +
      `${(r.pLo * 100).toFixed(1)}〜${(r.pHi * 100).toFixed(1)}%   ` +
      `${String(r.odds ?? '-').padStart(7)}   ${(r.evMean ?? 0).toFixed(2).padStart(6)}   ` +
      `${(r.evLo ?? 0).toFixed(2).padStart(6)}   ${buy ? '◎ 買' : '－'}`)
  }
  const buys = rows.filter((r) => r.evLo !== null && r.evLo >= 1.0).slice(0, 4)
  console.log(`\n=== 判定 ===`)
  if (!buys.length) {
    console.log(`  🔴 見送り。EV下限が1.0を超える出目がありません。`)
    const top = rows[0]
    console.log(`     最良でも ${top.combo}：EV平均${top.evMean?.toFixed(2)} だが下限${top.evLo?.toFixed(2)}。`)
    console.log(`     → **平均だけ見れば買いに見えるが、確率の裏付けが薄い。**`)
  } else {
    console.log(`  ◎ 買い ${buys.length}点：${buys.map((b) => b.combo).join(' / ')}`)
    console.log(`     投資 ${buys.length * 100}円   期待回収 ${Math.round(buys.reduce((a, b) => a + b.evMean * 100, 0))}円`)
  }
  console.log(`\n  ※ EV下限＝確率の事後分布の下側25%点で計算したEV。`)
  console.log(`     標本が薄い（nが小さい）ほど区間が広がり、下限が下がって弾かれる。`)
}
db.close()
