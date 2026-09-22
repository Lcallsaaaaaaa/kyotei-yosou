// 人気別の的中率と回収率を、うちのデータで実測する。
//   node --max-old-space-size=5120 scripts/ninki.mjs
//
// ★調べたいこと
//   一般論では「本命は買われ足りず、穴は買われすぎ」。競艇でも成り立つのか。
//   成り立つなら、モデルが本命を選んだときに市場より有利な位置にいることになる。
//   控除率25%なので、回収75%が「歪みゼロ」の基準線。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const rows = db.prepare(`
  SELECT o.race_id, o.lane, o.tansho, e.rank_num,
         ROW_NUMBER() OVER (PARTITION BY o.race_id ORDER BY o.tansho ASC) pop
  FROM odds_tan o JOIN entries e ON e.race_id=o.race_id AND e.lane=o.lane
  WHERE o.tansho IS NOT NULL`)
const P = new Array(7).fill(null).map(() => ({ n: 0, win: 0, ret: 0, odds: 0 }))
const L = new Array(7).fill(null).map(() => ({ n: 0, win: 0, ret: 0, odds: 0 }))
let races = new Set()
for (const r of rows.iterate()) {
  races.add(r.race_id)
  if (r.pop >= 1 && r.pop <= 6) {
    const a = P[r.pop]; a.n++; a.odds += r.tansho
    if (r.rank_num === 1) { a.win++; a.ret += r.tansho * 100 }
  }
  if (r.lane >= 1 && r.lane <= 6) {
    const b = L[r.lane]; b.n++; b.odds += r.tansho
    if (r.rank_num === 1) { b.win++; b.ret += r.tansho * 100 }
  }
}
console.log(`${races.size.toLocaleString()}レース（確定単勝オッズあり）\n`)
console.log('単勝を人気順に買い続けたら（控除率25%なので回収75%が歪みゼロの線）')
console.log('  人気   買った数   平均オッズ   的中率    回収率   歪み')
for (let i = 1; i <= 6; i++) {
  const a = P[i]; if (!a.n) continue
  const roi = a.ret / (a.n * 100) * 100
  console.log(`  ${i}番人気 ${String(a.n).padStart(9)} ${(a.odds / a.n).toFixed(2).padStart(11)} ${(a.win / a.n * 100).toFixed(2).padStart(8)}% ${roi.toFixed(2).padStart(8)}% ${((roi - 75) >= 0 ? '+' : '') + (roi - 75).toFixed(2)}pt`)
}
console.log('\n単勝を枠番で買い続けたら')
console.log('  枠     買った数   平均オッズ   的中率    回収率   歪み')
for (let i = 1; i <= 6; i++) {
  const a = L[i]; if (!a.n) continue
  const roi = a.ret / (a.n * 100) * 100
  console.log(`  ${i}号艇 ${String(a.n).padStart(10)} ${(a.odds / a.n).toFixed(2).padStart(11)} ${(a.win / a.n * 100).toFixed(2).padStart(8)}% ${roi.toFixed(2).padStart(8)}% ${((roi - 75) >= 0 ? '+' : '') + (roi - 75).toFixed(2)}pt`)
}
// オッズ帯別
console.log('\nオッズ帯ごと')
const B = [1.5, 2, 3, 4, 6, 10, 20, 50, 1e9]
const H = B.map(() => ({ n: 0, win: 0, ret: 0 }))
for (const r of rows.iterate()) {
  const i = B.findIndex((b) => r.tansho < b)
  if (i < 0) continue
  const a = H[i]; a.n++
  if (r.rank_num === 1) { a.win++; a.ret += r.tansho * 100 }
}
console.log('  オッズ      買った数   的中率    回収率   歪み')
let prev = 1
for (let i = 0; i < B.length; i++) {
  const a = H[i]; if (a.n < 500) { prev = B[i]; continue }
  const roi = a.ret / (a.n * 100) * 100
  const lab = B[i] > 1e8 ? `${prev}倍以上` : `${prev}〜${B[i]}倍`
  console.log(`  ${lab.padEnd(12)} ${String(a.n).padStart(8)} ${(a.win / a.n * 100).toFixed(2).padStart(8)}% ${roi.toFixed(2).padStart(8)}% ${((roi - 75) >= 0 ? '+' : '') + (roi - 75).toFixed(2)}pt`)
  prev = B[i]
}
db.close()
