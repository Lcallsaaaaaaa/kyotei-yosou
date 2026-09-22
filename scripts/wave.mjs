// 波高の効果と「波に強い選手」が実在するかを測る。
//
//   node scripts/wave.mjs
//
// ★なぜ測るか
//   2026/08/18 児島12Rで、ユーザーは 5-1-3 を的中させた。その根拠10点のうち3点が波高だった：
//     「波が高い時の勝率が5、3号艇が高かった」
//     「5号艇はターン時の引き波も超えられる」
//     「6号艇は高波に弱い傾向が強い」
//   一方こちらは風速は測ったが**波高を一度も見ていなかった**。DBには入っているのに。
//
// ★測る内容
//   ① 波高別のコース別1着率（そもそも波は効くのか）
//   ② 風速と波高は別物か（同じものなら片方でよい）
//   ③ 「波に強い選手」は実在するか
//      各選手の「高波での成績 − 平常時の成績」を集め、
//      そのばらつきが二項分布の偶然を超えていれば実在すると言える。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)
const pc = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '  -  ')
const se = (p, n) => Math.sqrt((p * (1 - p)) / n) * 100

// ---------- ① 波高別のコース別1着率 ----------
console.log('=== ① 波高別のコース別1着率 ===\n')
const WB = [0, 1, 2, 3, 4, 6, 9, 99]
const label = (i) => (i === WB.length - 2 ? `${WB[i]}cm〜` : `${WB[i]}〜${WB[i + 1] - 1}cm`)
const bucket = (w) => { for (let i = WB.length - 2; i >= 0; i--) if (w >= WB[i]) return i; return 0 }

const rows = all(`SELECT r.wave w, e.course c, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE r.wave IS NOT NULL AND e.course IS NOT NULL GROUP BY r.wave, e.course`)
const agg = {}
for (const r of rows) {
  const b = bucket(r.w)
  agg[b] ??= {}
  agg[b][r.c] ??= { n: 0, k: 0 }
  agg[b][r.c].n += r.n
  agg[b][r.c].k += r.k
}
console.log('波高        レース数   1コース  2コース  3コース  4コース  5コース  6コース')
for (let b = 0; b < WB.length - 1; b++) {
  const a = agg[b]
  if (!a || !a[1] || a[1].n < 500) continue
  const cells = [1, 2, 3, 4, 5, 6].map((c) => (a[c] ? pc(a[c].k, a[c].n).padStart(7) : '      -'))
  console.log(`${label(b).padEnd(10)}${String(a[1].n).padStart(8)}  ${cells.join(' ')}`)
}

// ---------- ② 風速と波高は別の情報か ----------
console.log('\n=== ② 風速と波高は別物か ===')
const wv = all(`SELECT wind_speed ws, wave wv FROM races WHERE wind_speed IS NOT NULL AND wave IS NOT NULL`)
const mx = wv.reduce((a, b) => a + b.ws, 0) / wv.length
const my = wv.reduce((a, b) => a + b.wv, 0) / wv.length
let sxy = 0, sxx = 0, syy = 0
for (const r of wv) { sxy += (r.ws - mx) * (r.wv - my); sxx += (r.ws - mx) ** 2; syy += (r.wv - my) ** 2 }
const corr = sxy / Math.sqrt(sxx * syy)
console.log(`  相関 ${corr.toFixed(4)}  → ${Math.abs(corr) < 0.6 ? '**別の情報。両方入れる価値がある**' : '重複が大きい'}`)

// ---------- ③ 「波に強い選手」は実在するか ----------
console.log('\n=== ③ 「波に強い選手」は実在するか ===')
console.log('  高波(4cm以上)での成績と平常時(3cm以下)の成績の差を、選手ごとに集める。')
console.log('  そのばらつきが偶然を超えていれば、波への強さは実在する。\n')
console.log('コース   対象選手   高波での平均   平常時の平均   差のばらつき  偶然ぶん   真の選手差')
for (let c = 1; c <= 6; c++) {
  const hi = new Map(), lo = new Map()
  for (const r of all(`SELECT e.racer_id, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=? AND r.wave >= 4 AND e.racer_id IS NOT NULL GROUP BY e.racer_id HAVING n >= 12`, c))
    hi.set(r.racer_id, r)
  for (const r of all(`SELECT e.racer_id, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=? AND r.wave <= 3 AND e.racer_id IS NOT NULL GROUP BY e.racer_id HAVING n >= 12`, c))
    lo.set(r.racer_id, r)

  const diffs = []
  let binom = 0, hiN = 0, hiK = 0, loN = 0, loK = 0
  for (const [id, h] of hi) {
    const l = lo.get(id)
    if (!l) continue
    const ph = h.k / h.n, pl = l.k / l.n
    diffs.push(ph - pl)
    binom += (ph * (1 - ph)) / h.n + (pl * (1 - pl)) / l.n
    hiN += h.n; hiK += h.k; loN += l.n; loK += l.k
  }
  if (diffs.length < 60) continue
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const obsVar = diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (diffs.length - 1)
  const binomVar = binom / diffs.length
  const trueVar = obsVar - binomVar
  console.log(`  ${c}    ${String(diffs.length).padStart(6)}    ${pc(hiK, hiN).padStart(7)}      ${pc(loK, loN).padStart(7)}      ` +
    `${obsVar.toFixed(5)}   ${binomVar.toFixed(5)}   ${trueVar > 0 ? trueVar.toFixed(5) + '  ★実在' : '  なし'}`)
}
console.log('\n  ※「真の選手差」が正なら、同じコース・同じ波でも選手によって強さが違う＝特徴量にする価値がある。')
db.close()
