// フライング・事故の履歴はスタートを慎重にさせるか？
//
//   node scripts/flying.mjs
//
// ★検証する仮説（2026/08/18 ユーザー提供）
//   「1号艇は事故とフライングの歴があるので、スタートが良くないと想定できた」
//
//   フライングを切ると出走停止などの重い罰則がある。
//   その後は当然慎重になるはずで、STが遅くなるなら予想に使える。
//
// ★測り方
//   同じ選手の中で「フライング直前の30走」と「直後の30走」のSTを比べる。
//   選手ごとの地力の差が消えるので、Fの影響だけが残る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)

const W = 30 // 前後それぞれ何走を比べるか

// 全出走を時系列で持つ
const rows = all(`SELECT e.racer_id, r.date, r.jcd, r.race_no, e.st, e.st_flag, e.rank_num, e.course
  FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE e.racer_id IS NOT NULL ORDER BY e.racer_id, r.date, r.jcd, r.race_no`)

const byRacer = new Map()
for (const r of rows) {
  if (!byRacer.has(r.racer_id)) byRacer.set(r.racer_id, [])
  byRacer.get(r.racer_id).push(r)
}

let nCase = 0
let beforeSum = 0, beforeN = 0, afterSum = 0, afterN = 0
const diffs = []
let bWin = 0, bRuns = 0, aWin = 0, aRuns = 0

for (const [, list] of byRacer) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].st_flag !== 'F') continue
    const before = list.slice(Math.max(0, i - W), i).filter((x) => x.st != null && x.st_flag === null)
    const after = list.slice(i + 1, i + 1 + W).filter((x) => x.st != null && x.st_flag === null)
    if (before.length < 10 || after.length < 10) continue
    nCase++
    const mb = before.reduce((a, b) => a + b.st, 0) / before.length
    const ma = after.reduce((a, b) => a + b.st, 0) / after.length
    beforeSum += mb; beforeN++
    afterSum += ma; afterN++
    diffs.push(ma - mb)
    bWin += before.filter((x) => x.rank_num === 1).length; bRuns += before.length
    aWin += after.filter((x) => x.rank_num === 1).length; aRuns += after.length
  }
}

console.log('=== フライングの前後でスタートは変わるか ===\n')
console.log(`対象 ${nCase} 件（前後それぞれ10走以上ある Fのみ・前後${W}走で比較）\n`)
if (!nCase) { console.log('該当なし'); db.close(); process.exit(0) }

const mb = beforeSum / beforeN, ma = afterSum / afterN
const md = diffs.reduce((a, b) => a + b, 0) / diffs.length
const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - md) ** 2, 0) / (diffs.length - 1))
const seM = sd / Math.sqrt(diffs.length)
console.log(`  F直前の平均ST  ${mb.toFixed(4)}`)
console.log(`  F直後の平均ST  ${ma.toFixed(4)}`)
console.log(`  差            ${md >= 0 ? '+' : ''}${md.toFixed(4)}秒  （±${(1.96 * seM).toFixed(4)}）`)
console.log(`  → ${Math.abs(md) < 1.96 * seM ? '**差は検出できず**' : md > 0 ? `**${(md * 16 * 100).toFixed(0)}cm ぶん遅くなる＝慎重になっている**` : '**逆に速くなっている**'}`)
console.log(`\n  1着率  直前 ${((bWin / bRuns) * 100).toFixed(1)}%  →  直後 ${((aWin / aRuns) * 100).toFixed(1)}%`)

// F持ち選手 vs F無し選手のST比較（別角度）
console.log('\n=== 直近1年でFがある選手とない選手のST比較 ===')
const fset = new Set(all(`SELECT DISTINCT racer_id FROM entries WHERE st_flag='F' AND racer_id IS NOT NULL`).map((r) => r.racer_id))
const st = all(`SELECT e.racer_id, e.course c, AVG(e.st) st, COUNT(*) n FROM entries e
  WHERE e.st IS NOT NULL AND e.st_flag IS NULL AND e.racer_id IS NOT NULL
  GROUP BY e.racer_id, e.course HAVING n >= 20`)
for (let c = 1; c <= 6; c++) {
  const g = st.filter((r) => r.c === c)
  const withF = g.filter((r) => fset.has(r.racer_id))
  const noF = g.filter((r) => !fset.has(r.racer_id))
  if (withF.length < 30 || noF.length < 30) continue
  const a = withF.reduce((x, y) => x + y.st, 0) / withF.length
  const b = noF.reduce((x, y) => x + y.st, 0) / noF.length
  console.log(`  ${c}コース  F歴あり ${a.toFixed(4)} (${withF.length}人)   F歴なし ${b.toFixed(4)} (${noF.length}人)   差 ${a - b >= 0 ? '+' : ''}${(a - b).toFixed(4)}`)
}
console.log('\n  ※ 正なら「F歴のある選手の方がSTが遅い」。')
db.close()
