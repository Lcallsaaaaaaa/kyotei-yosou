// 単勝オッズから、3連単・3連複の「市場が見ているオッズ」を推定する。
//   node --max-old-space-size=6144 scripts/harville.mjs
//
// ★考え方（Harville方式）
//   市場の1着確率 q（単勝オッズの逆数を正規化）が分かれば、
//   1着a・2着b・3着c の確率は
//     P(a-b-c) = q_a × q_b/(1-q_a) × q_c/(1-q_a-q_b)
//   で近似できる。「1着が抜けたら、残りで同じ比率で2着が決まる」という考え。
//   そこから 推定オッズ = 0.75 ÷ P（0.75は払戻率）。
//
// ★なぜ要るか
//   3連単のオッズは集めていない。でも単勝オッズは締切前に見える。
//   これで全120通りのオッズが推定できれば、
//   「モデルの確率 × 推定オッズ が一定以上の買い目だけ買う」という判定ができる。
//
// ★Harvilleは本命に寄りすぎる癖があるので、べき乗の補正を入れて合わせ込む。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
const PAY3 = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrentan' AND amount IS NOT NULL`).iterate())
  PAY3.set(r.race_id + '|' + r.combo, r.amount)
const PAYF = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku' AND amount IS NOT NULL`).iterate())
  PAYF.set(r.race_id + '|' + r.combo, r.amount)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
/** 市場の1着確率（単勝オッズから） */
const mktQ = (o, pw) => {
  const r = [1, 2, 3, 4, 5, 6].map((l) => (o[l] > 0 ? (1 / o[l]) ** pw : 0))
  const s = r.reduce((a, b) => a + b, 0)
  return r.map((v) => v / s)
}
/** Harville で 3連単の確率 */
const harv = (q, a, b, c) => {
  const d1 = 1 - q[a], d2 = 1 - q[a] - q[b]
  if (d1 <= 0 || d2 <= 0) return 0
  return q[a] * (q[b] / d1) * (q[c] / d2)
}
console.log('推定オッズが実際の配当と合うか（勝った組み合わせで確認）\n')
console.log('  べき乗  対象    推定/実配当の中央  ±20%以内  ±50%以内  対数のずれ')
for (const pw of [0.8, 0.9, 1.0, 1.1, 1.2]) {
  const rat = []
  for (const [rid, o] of OD) {
    const w = WIN.get(rid); if (!w || !w[1] || !w[2] || !w[3]) continue
    const pay = PAY3.get(rid + '|' + `${w[1]}-${w[2]}-${w[3]}`); if (!(pay > 0)) continue
    if (![1, 2, 3, 4, 5, 6].every((l) => o[l] > 0)) continue
    const q = mktQ(o, pw)
    const p = harv(q, w[1] - 1, w[2] - 1, w[3] - 1)
    if (!(p > 0)) continue
    rat.push((0.75 / p * 100) / pay)
  }
  if (rat.length < 1000) continue
  rat.sort((a, b) => a - b)
  const med = rat[Math.floor(rat.length / 2)]
  const in20 = rat.filter((x) => Math.abs(x - 1) < 0.2).length / rat.length * 100
  const in50 = rat.filter((x) => Math.abs(x - 1) < 0.5).length / rat.length * 100
  const ll = rat.reduce((a, x) => a + Math.abs(Math.log(x)), 0) / rat.length
  console.log(`  ${pw.toFixed(1)}  ${String(rat.length).padStart(7)} ${med.toFixed(3).padStart(16)} ${in20.toFixed(1).padStart(8)}% ${in50.toFixed(1).padStart(8)}% ${ll.toFixed(4).padStart(10)}`)
}
db.close()
