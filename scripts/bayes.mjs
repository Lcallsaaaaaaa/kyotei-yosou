// 当日の水面をベイズ更新する。
//
//   node scripts/bayes.mjs                       全場の事前分布の強さを推定
//   node scripts/bayes.mjs --jcd 16 --today 0/2  児島で当日0勝2敗のときの事後確率
//
// ★解きたい問題
//   2026/08/18 児島は 1R・2R とも1号艇が着外だった（イン0勝2敗）。
//   これを「n=2だから無視」も「イン受難だから重視」も、どちらも恣意的だった。
//   **どれだけ信じるべきか**をデータから決める。
//
// ★方法：Beta-二項の共役更新
//   その日の真のイン1着率 p_day が、場ごとの分布 Beta(α,β) から引かれると考える。
//   当日 n レース中 k 回インが勝ったのを観測したら、事後は Beta(α+k, β+n−k)。
//   事後平均 = (α+k)/(α+β+n)。
//
//   α+β（＝事前の強さ）はモーメント法で推定できる：
//     α+β = μ(1−μ)/σ² − 1      μ＝場の平均イン率、σ²＝日別イン率の分散
//
//   日ごとのばらつきσ²が大きいほど α+β は小さくなり、当日の観測が重く効く。
//   逆にどの日も似た結果ならσ²は小さく、α+βが大きくなって当日の観測は薄まる。
//   **「日による違いは実在するのか」を測って、そこから重みを決めている。**

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const JCD = {
  1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖',
  7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江',
  13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山',
  19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村',
}
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const onlyJcd = flag('jcd') ? Number(flag('jcd')) : null
const todayArg = flag('today') // "0/2" のような形式

/**
 * 場ごとに「日別イン1着率」を集め、事前分布 Beta(α,β) の強さを推定する。
 * 12レース程度の観測には二項分布由来のばらつきも含まれるので、
 * それを差し引いた「真の日間ばらつき」を使う（過大評価を避ける）。
 */
function estimatePrior(jcd) {
  const days = all(`
    SELECT r.date, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 ${jcd ? 'AND r.jcd=?' : ''}
    GROUP BY r.date HAVING n >= 8`, ...(jcd ? [jcd] : []))
  if (days.length < 20) return null

  const totN = days.reduce((a, b) => a + b.n, 0)
  const totK = days.reduce((a, b) => a + b.k, 0)
  const mu = totK / totN

  // 日別割合の観測分散
  const rates = days.map((d) => d.k / d.n)
  const obsVar = rates.reduce((a, r) => a + (r - mu) ** 2, 0) / (rates.length - 1)
  // 二項分布そのものが持つばらつき（1日あたり平均レース数で決まる）
  const nBar = totN / days.length
  const binomVar = (mu * (1 - mu)) / nBar
  // 真の日間ばらつき＝観測ぶん − 二項ぶん
  const rawTrue = obsVar - binomVar
  // 観測ぶらつきが二項ぶんを下回る＝日による差が検出できない。
  // このとき強さは無限大に発散するので、天井を置いて「検出されず」と印を付ける。
  const undetected = rawTrue <= 0
  const trueVar = Math.max(rawTrue, 1e-4)
  const strength = Math.min(Math.max((mu * (1 - mu)) / trueVar - 1, 1), 2500)
  return {
    days: days.length, nBar, mu, obsVar, binomVar, trueVar, undetected,
    strength, alpha: strength * mu, beta: strength * (1 - mu),
  }
}

if (todayArg) {
  const [k, n] = todayArg.split('/').map(Number)
  const p = estimatePrior(onlyJcd)
  if (!p) { console.error('データ不足'); process.exit(1) }
  const name = onlyJcd ? JCD[onlyJcd] : '全場'
  console.log(`=== ${name} の当日ベイズ更新 ===\n`)
  console.log(`事前分布（過去1年の${p.days}日から推定）`)
  console.log(`  平均イン1着率 μ = ${(p.mu * 100).toFixed(1)}%`)
  console.log(`  日別ばらつき（観測）      σ²_obs   = ${p.obsVar.toFixed(5)}`)
  console.log(`  うち二項分布由来          σ²_binom = ${p.binomVar.toFixed(5)}  （1日平均${p.nBar.toFixed(1)}レース）`)
  console.log(`  差し引いた真の日間ばらつき σ²_true  = ${p.trueVar.toFixed(5)}`)
  console.log(`  → 事前の強さ α+β = ${p.strength.toFixed(1)}  （Beta(${p.alpha.toFixed(1)}, ${p.beta.toFixed(1)})）`)
  console.log(`     ※ これは「当日の観測${p.strength.toFixed(0)}レースぶんの重みを事前が持つ」という意味\n`)

  const postMean = (p.alpha + k) / (p.strength + n)
  const postVar = ((p.alpha + k) * (p.beta + n - k)) / ((p.strength + n) ** 2 * (p.strength + n + 1))
  const sd = Math.sqrt(postVar)
  console.log(`当日の観測: ${n}レース中 ${k}回イン1着（${((k / n) * 100).toFixed(1)}%）\n`)
  console.log(`事後分布`)
  console.log(`  事後平均 = ${(postMean * 100).toFixed(1)}%   （事前 ${(p.mu * 100).toFixed(1)}% から ${((postMean - p.mu) * 100).toFixed(1)}pt 移動）`)
  console.log(`  95%区間  ≈ ${((postMean - 1.96 * sd) * 100).toFixed(1)}% 〜 ${((postMean + 1.96 * sd) * 100).toFixed(1)}%`)
  console.log(`\n  → 当日${n}レースの観測は、イン率の見積もりを **${Math.abs((postMean - p.mu) * 100).toFixed(1)}pt しか動かさない**。`)
  console.log(`     「n=2だから無視」でも「イン受難だから重視」でもなく、この数字ぶんだけ動かすのが正しい。`)

  // 観測レース数ごとの感度
  console.log(`\n=== 参考：当日の観測が増えると事後平均はどう動くか（全敗し続けた場合）===`)
  console.log('観測レース数   事後平均')
  for (const nn of [2, 4, 6, 8, 10, 12]) {
    console.log(`   ${String(nn).padStart(2)}レース0勝   ${((p.alpha) / (p.strength + nn) * 100).toFixed(1)}%`)
  }
} else {
  console.log('=== 場ごとの「日によるイン率のばらつき」と事前分布の強さ ===\n')
  console.log('  事前の強さ＝当日の観測が事前を動かしにくい度合い。大きいほど「日による違いは小さい」。\n')
  console.log('場        日数  平均イン率  真の日間ばらつき  事前の強さ  当日6R全敗なら')
  const rows = []
  for (const jcd of Object.keys(JCD).map(Number)) {
    const p = estimatePrior(jcd)
    if (!p) continue
    rows.push({ jcd, ...p, after6: p.alpha / (p.strength + 6) })
  }
  for (const r of rows.sort((a, b) => a.strength - b.strength)) {
    console.log(
      `${JCD[r.jcd].padEnd(5, '　')}${String(r.days).padStart(5)}  ${(r.mu * 100).toFixed(1)}%      ` +
      `${r.undetected ? '  検出されず' : r.trueVar.toFixed(5)}        ${r.undetected ? '  (上限)' : r.strength.toFixed(1).padStart(6)}      ${(r.after6 * 100).toFixed(1)}%`)
  }
  const det = rows.filter((r) => !r.undetected).map((r) => r.strength).sort((a, b) => a - b)
  const med = det[Math.floor(det.length / 2)]
  console.log(`\n  日間変動が検出できた ${det.length}場の中央値 = ${med.toFixed(1)}`)
  console.log(`  検出できなかった ${rows.length - det.length}場（芦屋・平和島・江戸川）は、日ごとの差が偶然の範囲に収まっている。`)
  console.log(`  → **これらの場では「当日の傾向」を見ても意味がない。** 事前（年間ベースレート）をそのまま使う。`)
  console.log(`\n  ※ 強さは「当日◯レースぶんの重みを事前が持つ」という意味。`)
  console.log(`     強さ31の児島なら当日6レースは 31:6 で薄まり、強さ1020の鳴門なら当日は事実上無視される。`)
}
db.close()
