// 着順確率の作り方を比べる（Harville / 割引つき / いまの学習済み段階）。
//   node --max-old-space-size=8192 scripts/discount.mjs
//
// ★文献の要点
//   Harville(1973) … 1着確率だけから、順に取り除いて2着3着を割り当てる。
//                    我々のPlackett-Luceと同じ。**本命を2着に置きすぎる偏り**が知られている。
//   Henery(1981)  … 走破時間を正規分布と仮定。2連単3連単ではHarvilleより良いとされる。
//   Discounted Harville … 2着の割り当てに p^λ（λ<1）を使って本命を割り引く。実務で使われる形。
//
// ★ここで比べるもの
//   A いまのモデル（段階ごとに係数を学習した wi3）
//   B Harville（1着確率だけから作る）
//   C 割引つきHarville（λ, μ を振る）
//   本当の1着を知っている前提の2着的中も出すので、2着そのものの実力が分かる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1`).iterate()) {
  let a = P1.get(r.race_id); if (!a) { a = []; P1.set(r.race_id, a) }
  a.push(r)
}
const P3 = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = P3.get(r.race_id); if (!a) { a = new Map(); P3.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
for (const [rid, bs] of P1) {
  if (bs.length !== 6) continue
  const w = WIN.get(rid); if (!w || !w[1] || !w[2] || !w[3]) continue
  const m = P3.get(rid); if (!m) continue
  bs.sort((a, b) => a.lane - b.lane)
  races.push({ rid, lanes: bs.map((b) => b.lane), p: bs.map((b) => b.p), w, m })
}
console.log(`${races.length.toLocaleString()}レース\n`)
/** 1着確率から着順確率を作る。lam=2着の割引、mu=3着の割引 */
const build = (r, lam, mu) => {
  const out = new Map()
  const n = 6, p = r.p, L = r.lanes
  for (let a = 0; a < n; a++) {
    // 2着の候補は a を除いた5艇。p^lam で重みづけ
    const i2 = [], w2 = []
    for (let i = 0; i < n; i++) if (i !== a) { i2.push(i); w2.push(Math.pow(Math.max(p[i], 1e-9), lam)) }
    const s2 = w2.reduce((x, y) => x + y, 0)
    for (let k = 0; k < i2.length; k++) {
      const b = i2[k]
      const i3 = [], w3 = []
      for (let i = 0; i < n; i++) if (i !== a && i !== b) { i3.push(i); w3.push(Math.pow(Math.max(p[i], 1e-9), mu)) }
      const s3 = w3.reduce((x, y) => x + y, 0)
      for (let j = 0; j < i3.length; j++)
        out.set(`${L[a]}-${L[b]}-${L[i3[j]]}`, p[a] * (w2[k] / s2) * (w3[j] / s3))
    }
  }
  return out
}
const score = (get, nm) => {
  let n = 0, t1 = 0, t3 = 0, t6 = 0, s1 = 0, s6 = 0, c2n = 0, c2h = 0, c2h2 = 0, ll = 0
  for (const r of races) {
    const m = get(r)
    n++
    const truth2 = `${r.w[1]}-${r.w[2]}`, truth3 = `${r.w[1]}-${r.w[2]}-${r.w[3]}`
    const m2 = new Map()
    for (const [c, p] of m) { const k = c.slice(0, c.lastIndexOf('-')); m2.set(k, (m2.get(k) ?? 0) + p) }
    const a2 = [...m2].sort((x, y) => y[1] - x[1])
    const a3 = [...m].sort((x, y) => y[1] - x[1])
    if (a2[0][0] === truth2) t1++
    if (a2.slice(0, 3).some(([k]) => k === truth2)) t3++
    if (a2.slice(0, 6).some(([k]) => k === truth2)) t6++
    if (a3[0][0] === truth3) s1++
    if (a3.slice(0, 6).some(([k]) => k === truth3)) s6++
    const p3 = m.get(truth3) ?? 1e-9
    ll -= Math.log(Math.max(p3, 1e-12))
    // 1着を知っている前提の2着
    const c = a2.filter(([k]) => Number(k.slice(0, k.indexOf('-'))) === r.w[1])
    if (c.length) { c2n++; if (c[0][0] === truth2) c2h++; if (c.slice(0, 2).some(([k]) => k === truth2)) c2h2++ }
  }
  console.log(`  ${nm.padEnd(26)} 2連単1点 ${(t1 / n * 100).toFixed(2)}%  3点 ${(t3 / n * 100).toFixed(2)}%  6点 ${(t6 / n * 100).toFixed(2)}%  3連単1点 ${(s1 / n * 100).toFixed(2)}%  6点 ${(s6 / n * 100).toFixed(2)}%  2着(1着既知) ${(c2h / c2n * 100).toFixed(2)}%  対数損失 ${(ll / n).toFixed(4)}`)
}
console.log('★ いまのモデル（段階ごとに係数を学習）')
score((r) => r.m, '学習済み3段階')
console.log('\n★ 1着確率だけから作る（Harville系）')
score((r) => build(r, 1.0, 1.0), 'Harville（割引なし）')
for (const lam of [0.9, 0.8, 0.7, 0.6, 0.5]) score((r) => build(r, lam, lam), `割引 λ=μ=${lam.toFixed(1)}`)
console.log('\n★ 2着と3着で割引を変える')
for (const lam of [0.8, 0.7, 0.6]) for (const mu of [0.8, 0.6, 0.4])
  if (lam !== mu) score((r) => build(r, lam, mu), `2着λ=${lam.toFixed(1)} 3着μ=${mu.toFixed(1)}`)
db.close()
