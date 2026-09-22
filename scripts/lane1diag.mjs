// 「1号艇を本命にしたとき、実際は3〜6号艇が来ているのでは」を確かめる。
//
//   node --max-old-space-size=8192 scripts/lane1diag.mjs
//
// ★問い
//   モデルは83%のレースで1号艇を本命にする。
//   それは「1〜3号艇が勝つレースを探している」だけで、
//   本当に勝つ艇を当てているわけではないのではないか、という指摘。
//
// ★確かめ方
//   ① 1号艇の予測確率の帯ごとに、実際の1着分布を出す。
//      モデルが効いているなら、確率が低い帯ほど3〜6号艇の1着が増えるはず。
//   ② 「何もしない基準」と比べる。
//      基準＝その場の1号艇平均1着率だけで予想した場合。
//      モデルがそれを超えていなければ、指摘のとおり何も足していない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

const byRace = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()) {
  let a = byRace.get(r.race_id); if (!a) { a = []; byRace.set(r.race_id, a) }
  a.push(r)
}
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,jcd FROM races`).all()) RC.set(r.race_id, r.jcd)

const R = []
for (const [rid, a] of byRace) {
  if (a.length !== 6) continue
  const win = a.find((x) => x.y === 1); if (!win) continue
  R.push({ rid, jcd: RC.get(rid), p1: a.find((x) => x.lane === 1).p,
    fav: a.reduce((m, x) => (x.p > m.p ? x : m)).lane, win: win.lane })
}
console.log(`対象 ${R.length.toLocaleString()}レース`)
const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '-'

console.log('\n════ ① 1号艇の予測確率の帯ごとに、実際は誰が勝ったか ════')
console.log('1号艇の予測    レース数   1号艇   2号艇   3〜6号艇    1号艇の実際 vs 予測')
const BK = [[0, .25], [.25, .40], [.40, .55], [.55, .70], [.70, .85], [.85, 1.01]]
for (const [lo, hi] of BK) {
  const s = R.filter((x) => x.p1 >= lo && x.p1 < hi)
  if (s.length < 200) continue
  const w1 = s.filter((x) => x.win === 1).length
  const w2 = s.filter((x) => x.win === 2).length
  const w36 = s.filter((x) => x.win >= 3).length
  const ap = s.reduce((a, x) => a + x.p1, 0) / s.length
  const d = (ap - w1 / s.length) * 100
  console.log(`${(lo * 100).toFixed(0).padStart(3)}〜${(hi * 100).toFixed(0).padStart(3)}% ${String(s.length).padStart(11)} ${pct(w1, s.length).padStart(7)} ${pct(w2, s.length).padStart(7)} ${pct(w36, s.length).padStart(9)}    ${(ap * 100).toFixed(1)}% → ${pct(w1, s.length)}  ${d > 1.5 ? '★' + d.toFixed(1) + 'pt過大' : d < -1.5 ? d.toFixed(1) + 'pt過小' : '一致'}`)
}

console.log('\n════ ② 1号艇を本命にしたとき、3〜6号艇はどれだけ来るか ════')
const f1 = R.filter((x) => x.fav === 1)
const base36 = R.filter((x) => x.win >= 3).length / R.length
console.log(`  全レース平均              3〜6号艇の1着 ${pct(R.filter((x) => x.win >= 3).length, R.length)}`)
console.log(`  1号艇を本命にした${f1.length.toLocaleString()}レース  3〜6号艇の1着 ${pct(f1.filter((x) => x.win >= 3).length, f1.length)}`)
console.log(`  → 本命1号艇にしても、3〜6号艇の1着は ${((base36 - f1.filter((x) => x.win >= 3).length / f1.length) * 100).toFixed(1)}pt しか減らない`)

console.log('\n════ ③ モデルは「何もしない基準」を超えているか ════')
// 基準：その場の1号艇平均1着率をそのまま予測値にする
const byV = new Map()
for (const x of R) { const a = byV.get(x.jcd) || [0, 0]; a[0]++; if (x.win === 1) a[1]++; byV.set(x.jcd, a) }
const baseP = (jcd) => { const a = byV.get(jcd); return a ? a[1] / a[0] : 0.55 }
const brier = (fn) => R.reduce((a, x) => { const p = fn(x); const y = x.win === 1 ? 1 : 0; return a + (p - y) ** 2 }, 0) / R.length
const bModel = brier((x) => x.p1)
const bVenue = brier((x) => baseP(x.jcd))
const bFlat = brier(() => R.filter((x) => x.win === 1).length / R.length)
console.log(`  ブライアスコア（小さいほど良い・1号艇が勝つかの予測）`)
console.log(`    全レース同じ値（1号艇の平均1着率）        ${bFlat.toFixed(4)}`)
console.log(`    場ごとの1号艇平均1着率だけ                ${bVenue.toFixed(4)}`)
console.log(`    モデル                                    ${bModel.toFixed(4)}   改善 ${((1 - bModel / bVenue) * 100).toFixed(1)}%`)

console.log('\n════ ④ モデルが「1号艇は来ない」と言ったとき、当たっているか ════')
const low = R.filter((x) => x.p1 < 0.35)
console.log(`  1号艇の予測35%未満 ${low.length.toLocaleString()}レース`)
console.log(`    実際に1号艇が負けた ${pct(low.filter((x) => x.win !== 1).length, low.length)}（全レース平均は ${pct(R.filter((x) => x.win !== 1).length, R.length)}）`)
console.log(`    そのとき本命にした艇が勝った ${pct(low.filter((x) => x.win === x.fav).length, low.length)}`)
console.log(`    実際に勝った艇の内訳  ${[1, 2, 3, 4, 5, 6].map((k) => `${k}:${pct(low.filter((x) => x.win === k).length, low.length)}`).join(' ')}`)
db.close()
