// 「選手×コース×競艇場」の成績は、全場成績を超える情報を持つか？
//
//   node scripts/venue-skill.mjs
//
// ★問い
//   いまのモデルは選手の成績を全場まとめて使っている（racerP1/P2/P3）。
//   場は venueBase（場全体のコース別1着率）としてしか入っておらず、
//   「この選手はこの場が得意」という当地の情報が抜けている。
//
//   だが当地成績は標本が薄い（下関の山崎郡は1コース5走しかなかった）。
//   薄い標本の当地成績を足すと、実力ではなく偶然を拾って精度が落ちる可能性がある。
//
// ★測り方
//   選手の当地成績が全場成績からどれだけズレるかを見る。
//   もし「当地の得意不得意」が実在しないなら、そのズレは二項分布の偶然だけで説明できるはず。
//   偶然で説明できる以上にズレていれば、当地の効果は実在する。
//     観測ズレの分散 − 二項分布由来の分散 = 真の当地効果の分散
//   そこから当地補正の縮小の強さ K_local も出す（階層ベイズの2段目）。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const MIN_LOCAL = 8   // 当地でこれ以上走っている組だけ見る
const MIN_NAT = 30    // 全場でこれ以上走っている選手だけ（全場成績を信頼できる水準）

console.log('=== 当地成績は全場成績を超える情報を持つか ===\n')
console.log(`条件：全場${MIN_NAT}走以上かつ当地${MIN_LOCAL}走以上の「選手×コース×場」\n`)

const out = {}
console.log('コース   組数    平均      当地ズレの分散  偶然ぶん   真の当地効果   K_local   判定')

for (let c = 1; c <= 6; c++) {
  // 全場の成績
  const nat = new Map()
  for (const r of all(`SELECT racer_id, COUNT(*) n, SUM(rank_num=1) w FROM entries
    WHERE course=? AND racer_id IS NOT NULL AND rank_num IS NOT NULL
    GROUP BY racer_id HAVING n >= ?`, c, MIN_NAT)) {
    nat.set(r.racer_id, { n: r.n, w: r.w, p: r.w / r.n })
  }
  // 当地の成績
  const loc = all(`SELECT e.racer_id, r.jcd, COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=? AND e.racer_id IS NOT NULL AND e.rank_num IS NOT NULL
    GROUP BY e.racer_id, r.jcd HAVING n >= ?`, c, MIN_LOCAL)

  const diffs = []
  let binomSum = 0
  for (const r of loc) {
    const nt = nat.get(r.racer_id)
    if (!nt) continue
    // 当地ぶんを除いた全場成績を基準にする（同じデータで比べると自己相関が出るため）
    const restN = nt.n - r.n
    const restW = nt.w - r.w
    if (restN < MIN_NAT / 2) continue
    const pRest = restW / restN
    const pLoc = r.w / r.n
    diffs.push(pLoc - pRest)
    // この組で偶然だけで生じるズレの分散
    binomSum += pRest * (1 - pRest) / r.n + pRest * (1 - pRest) / restN
  }
  if (diffs.length < 100) continue

  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const obsVar = diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (diffs.length - 1)
  const binomVar = binomSum / diffs.length
  const trueVar = obsVar - binomVar

  // 当地効果が実在するなら、その分散から縮小の強さを出す
  const pAvg = [...nat.values()].reduce((a, b) => a + b.p, 0) / nat.size
  const kLocal = trueVar > 0 ? (pAvg * (1 - pAvg)) / trueVar - 1 : null
  const verdict = trueVar <= 0 ? '効果なし'
    : trueVar / obsVar < 0.15 ? 'ごく弱い' : '実在'

  out[c] = { n: diffs.length, obsVar, binomVar, trueVar, kLocal, verdict }
  console.log(
    `  ${c}   ${String(diffs.length).padStart(6)}  ${(pAvg * 100).toFixed(1)}%    ` +
    `${obsVar.toFixed(5)}      ${binomVar.toFixed(5)}    ${trueVar > 0 ? trueVar.toFixed(5) : '  なし '}    ` +
    `${kLocal && kLocal > 0 ? kLocal.toFixed(0).padStart(6) : '     -'}   ${verdict}`)
}

console.log('\n=== 読み方 ===')
console.log('  「当地ズレの分散」のうち「偶然ぶん」を引いた残りが、当地の得意不得意の実体。')
console.log('  残りがゼロ以下なら、当地成績のブレは**すべて偶然**で説明できる＝足す価値がない。')
console.log('  K_local が小さいほど当地効果が強く、当地成績を信じてよい。')

const real = Object.entries(out).filter(([, v]) => v.trueVar > 0)
console.log(`\n  → 当地効果が検出できたコース: ${real.length ? real.map(([c]) => c + 'コース').join(' / ') : 'なし'}`)
if (real.length) {
  const share = real.map(([c, v]) => `${c}コース ${((v.trueVar / v.obsVar) * 100).toFixed(0)}%`).join(' / ')
  console.log(`     当地ズレのうち実力で説明できる割合: ${share}`)
}
writeFileSync(join(ROOT, 'data', 'venue-skill.json'), JSON.stringify(out, null, 2))
console.log('\n保存: data/venue-skill.json')
db.close()
