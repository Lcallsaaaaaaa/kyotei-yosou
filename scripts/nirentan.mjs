// 2連単で的中率90%に届くには何点買う必要があるか。そのとき回収率はどうなるか。
//
//   node --max-old-space-size=8192 scripts/nirentan.mjs
//
// ★問い（本人の目標）
//   全レースを通して的中率90%まで持っていきたい。2連単なら。
//
// ★測ること
//   モデルの確率が高い順に N 点買ったとき
//     ・的中率が何%になるか（N=1〜30）
//     ・そのときの回収率（実払戻）
//     ・平均オッズ
//   90%に届く N を見つけ、その点数で買ったときの収支を出す。
//
// ★2連単の確率は wk3（3連単120通り）から作る
//   同じ1着2着の組を持つ3着違いを足し上げれば2連単30通りになる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

// 実払戻（2連単）
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id,combo,amount FROM payouts WHERE bet_type='nirentan' AND amount>0`).all())
  PAY.set(r.race_id + '|' + r.combo, r.amount / 100)
console.log(`2連単の実払戻 ${PAY.size.toLocaleString()}レース`)

// wk3（3連単）→ 2連単に畳む
const R = new Map()
for (const r of db.prepare(`SELECT race_id,combo,p FROM wk3`).all()) {
  const i = r.combo.lastIndexOf('-')
  const k2 = r.combo.slice(0, i)                 // "1-2-3" → "1-2"
  let m = R.get(r.race_id); if (!m) { m = new Map(); R.set(r.race_id, m) }
  m.set(k2, (m.get(k2) ?? 0) + r.p)
}
console.log(`予想のあるレース ${R.size.toLocaleString()}\n`)

// レースごとに確率順に並べる
const races = []
for (const [rid, m] of R) {
  if (!PAY.size) break
  const order = [...m].sort((a, b) => b[1] - a[1])
  // そのレースの2連単払戻（当たった組が1つあるはず）
  let hitCombo = null, hitPay = 0
  for (const [k] of order) { const p = PAY.get(rid + '|' + k); if (p != null) { hitCombo = k; hitPay = p; break } }
  if (hitCombo == null) continue                  // 結果が無い or 返還
  const rank = order.findIndex(([k]) => k === hitCombo) + 1   // 何番目に当たったか
  races.push({ rid, rank, pay: hitPay })
}
console.log(`採点できたレース ${races.length.toLocaleString()}\n`)

console.log('════ 確率が高い順に N 点買ったとき ════')
console.log('  点数   的中率      的中数    投資        払戻        収支         回収率')
let cumPay = 0
const target = []
for (let N = 1; N <= 30; N++) {
  const hit = races.filter((x) => x.rank <= N)
  cumPay = hit.reduce((a, x) => a + x.pay, 0)
  const bet = races.length * N
  const roi = cumPay / bet
  const hr = hit.length / races.length
  const mark = hr >= 0.9 && target.length === 0 ? '  ← 90%到達' : ''
  if (hr >= 0.9 && !target.length) target.push({ N, hr, roi })
  if (N <= 12 || N % 3 === 0 || mark)
    console.log(`${String(N).padStart(6)} ${(hr * 100).toFixed(2).padStart(8)}% ${String(hit.length).padStart(9)} ${(bet * 100).toLocaleString().padStart(12)}円 ${Math.round(cumPay * 100).toLocaleString().padStart(12)}円 ${Math.round((cumPay - bet) * 100).toLocaleString().padStart(13)}円 ${(roi * 100).toFixed(1).padStart(8)}%${mark}`)
}

if (target.length) {
  const t = target[0]
  console.log(`\n★ 的中率90%には ${t.N}点必要。そのときの回収率 ${(t.roi * 100).toFixed(1)}%`)
} else {
  const last = races.filter((x) => x.rank <= 30).length / races.length
  console.log(`\n★ 30点（全通り）買っても的中率 ${(last * 100).toFixed(2)}%。90%に届かない`)
}

console.log('\n════ 参考：何番目に当たっているかの分布 ════')
for (let N = 1; N <= 10; N++) {
  const c = races.filter((x) => x.rank === N).length
  console.log(`  ${String(N).padStart(2)}番目 ${(c / races.length * 100).toFixed(2).padStart(6)}%  累計 ${(races.filter((x) => x.rank <= N).length / races.length * 100).toFixed(2)}%`)
}

console.log('\n════ 参考：的中したときの平均払戻（何番目に当たったか別） ════')
for (let N = 1; N <= 10; N++) {
  const s = races.filter((x) => x.rank === N)
  if (!s.length) continue
  console.log(`  ${String(N).padStart(2)}番目に的中 ${String(s.length).padStart(7)}本  平均払戻 ${Math.round(s.reduce((a, x) => a + x.pay, 0) / s.length * 100).toLocaleString()}円`)
}
db.close()
