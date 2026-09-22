// 階層ベイズ（経験ベイズ）で「縮小の強さ」をデータから推定する。
//
//   node scripts/hbayes.mjs
//
// ★何が問題だったか
//   選手のコース別成績は標本が薄い（1コースで年5〜30走程度）。
//   そのままだと「3走2勝＝66.7%」のようなノイズを買い目にしてしまうので
//   `(hits + K*prior) / (n + K)` と場平均へ引き寄せていた。
//   **だが K=25 は私が手で決めた数字で、何の根拠もなかった。**
//
// ★正しいやり方
//   「選手ごとの真の勝率」が Beta(α,β) から引かれていると考える階層モデルを置き、
//   観測（各選手の n走 k勝）から α,β を最尤推定する。
//   このとき **K = α+β** が縮小の強さそのものになる。
//   ベータ二項分布の周辺尤度：
//     L(α,β) = Π_i B(α+k_i, β+n_i−k_i) / B(α,β)
//   これを最大化する。コースごとに別々に推定する（1コースと6コースで散らばり方が違うため）。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

// --- log Γ（Lanczos近似）---
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
]
function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  z -= 1
  let x = 0.99999999999980993
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1)
  const t = z + LANCZOS.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
const logBeta = (a, b) => logGamma(a) + logGamma(b) - logGamma(a + b)

/** ベータ二項の周辺対数尤度 */
function marginalLL(obs, alpha, beta) {
  if (alpha <= 0 || beta <= 0) return -Infinity
  const base = logBeta(alpha, beta)
  let ll = 0
  for (const [k, n] of obs) ll += logBeta(alpha + k, beta + n - k) - base
  return ll
}

/** (平均μ, 強さK) の格子探索 → 近傍を細かく詰める */
function fitBetaBinomial(obs) {
  const totK = obs.reduce((a, b) => a + b[0], 0)
  const totN = obs.reduce((a, b) => a + b[1], 0)
  const mu0 = totK / totN
  let best = { mu: mu0, K: 25, ll: -Infinity }
  const scan = (mus, Ks) => {
    for (const mu of mus) for (const K of Ks) {
      const ll = marginalLL(obs, mu * K, (1 - mu) * K)
      if (ll > best.ll) best = { mu, K, ll }
    }
  }
  scan(
    Array.from({ length: 21 }, (_, i) => Math.max(0.005, mu0 * (0.7 + i * 0.03))),
    [2, 4, 6, 8, 12, 16, 22, 30, 40, 55, 75, 100, 140, 200, 300, 500])
  // 近傍を細かく
  scan(
    Array.from({ length: 21 }, (_, i) => Math.max(0.005, best.mu * (0.9 + i * 0.01))),
    Array.from({ length: 25 }, (_, i) => best.K * (0.6 + i * 0.035)))
  return best
}

const TARGETS = [
  ['1着率', 'SUM(e.rank_num=1)'],
  ['2着率', 'SUM(e.rank_num=2)'],
  ['3着率', 'SUM(e.rank_num=3)'],
]

console.log('=== 階層ベイズで「縮小の強さ K」を推定 ===')
console.log('  K は「事前分布が観測何走ぶんの重みを持つか」。手で決めていた 25 と比べる。\n')

const results = {}
for (const [name, expr] of TARGETS) {
  console.log(`--- ${name} ---`)
  console.log('コース  選手数   平均      推定K    （参考）手動K=25との比')
  results[name] = {}
  for (let c = 1; c <= 6; c++) {
    // 標本が極端に薄い選手はノイズなので最低走数を設ける
    const rows = all(`SELECT e.racer_id, COUNT(*) n, ${expr} k
      FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE e.course=? AND e.racer_id IS NOT NULL AND e.rank_num IS NOT NULL
      GROUP BY e.racer_id HAVING n >= 3`, c)
    if (rows.length < 50) continue
    const obs = rows.map((r) => [r.k, r.n])
    const fit = fitBetaBinomial(obs)
    results[name][c] = fit
    const ratio = fit.K / 25
    console.log(`  ${c}   ${String(rows.length).padStart(5)}   ${(fit.mu * 100).toFixed(1)}%   ${fit.K.toFixed(1).padStart(7)}    ${ratio < 1 ? '弱め' : '強め'} ×${ratio.toFixed(2)}`)
  }
  console.log('')
}

console.log('=== 解釈 ===')
const k1 = results['1着率']
console.log(`  1着率のK: ${[1, 2, 3, 4, 5, 6].map((c) => k1[c] ? `${c}コース${k1[c].K.toFixed(0)}` : '').filter(Boolean).join(' / ')}`)
console.log('')
console.log('  Kが小さいコース＝選手による実力差が大きい ⇒ 本人の実績を信じてよい')
console.log('  Kが大きいコース＝選手による差が小さい     ⇒ 平均へ強く引き寄せるべき')
console.log('')
console.log('  ※ 手動の K=25 を全コース一律に使っていたのは、この差を無視していたということ。')

// 実際に推定値がどれだけ変わるか
console.log('\n=== 影響の大きさ：n走k勝の選手の推定1着率がどう変わるか ===')
console.log('コース  実績        手動K=25     階層ベイズ    差')
for (const c of [1, 4, 6]) {
  const f = k1[c]
  if (!f) continue
  for (const [k, n] of [[3, 5], [8, 15], [20, 30]]) {
    const manual = (k + 25 * f.mu) / (n + 25)
    const hb = (k + f.K * f.mu) / (n + f.K)
    console.log(`  ${c}    ${n}走${k}勝   ${(manual * 100).toFixed(1)}%       ${(hb * 100).toFixed(1)}%      ${((hb - manual) * 100 >= 0 ? '+' : '') + ((hb - manual) * 100).toFixed(1)}pt`)
  }
}
// 本番スクリプトから読めるよう保存する
const out = {}
for (const [name, byCourse] of Object.entries(results)) {
  out[name] = {}
  for (const [c, f] of Object.entries(byCourse)) out[name][c] = { mu: f.mu, K: f.K }
}
writeFileSync(join(ROOT, 'data', 'shrinkage.json'), JSON.stringify(out, null, 2))
console.log('\n保存: data/shrinkage.json')
db.close()
