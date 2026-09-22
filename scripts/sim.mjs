// レースを何千回も走らせて着順を出す（モンテカルロ）。
//
//   node --max-old-space-size=8192 scripts/sim.mjs --t1 wi1 --n 4000
//
// ★いまのやり方との違い
//   いまは「1着を選ぶ → 除いて2着を選ぶ → 除いて3着を選ぶ」という逐次の式。
//   これは数学的には「各艇に 強さ＋ガンベル分布の運 を振って速い順に並べる」のと同じ。
//   つまり**運の分布の形をガンベルに決め打ちしている**。
//
//   実際の競艇は「強さ＋運」で、中日スポーツの分析では運の標準偏差が90、
//   枠の差（1枠と2枠で70）より大きい。運の形が違えば2着3着の出方は変わる。
//
// ★試す運の形
//   ガンベル … いまと同じ（対照）
//   正規     … 裾が軽い。強い艇が順当に上位を占めやすい
//   裾の重い … たまに大きく外れる。荒れを表現できる
//   コース別 … 外枠ほど運の幅を大きくする（まくりが決まるかどうかの振れ）
//
// ★強さはモデルの1着確率から逆算する
//   モデルを作り直さない。1着確率 p から強さ s = log(p) を取り、
//   運を足して並べるだけ。集計方法だけを変えて比べる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'wi1')
const NSIM = Number(flag('n', 4000))

const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM ${T1}`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const races = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const w = WIN.get(rid); if (!w || !w[1] || !w[2] || !w[3]) continue
  bs.sort((a, b) => a.lane - b.lane)
  races.push({ rid, lanes: bs.map((b) => b.lane), s: bs.map((b) => Math.log(Math.max(b.p, 1e-9))), w })
}
console.log(`${races.length.toLocaleString()}レース　1レースあたり${NSIM}回走らせる\n`)

// ---------- 乱数（再現できるように種を固定） ----------
let seed = 20260829
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) + 1) / 4294967297 }
const gumbel = () => -Math.log(-Math.log(rnd()))
let spare = null
const normal = () => {
  if (spare != null) { const v = spare; spare = null; return v }
  const u = rnd(), v = rnd()
  const r = Math.sqrt(-2 * Math.log(u))
  spare = r * Math.sin(2 * Math.PI * v)
  return r * Math.cos(2 * Math.PI * v)
}
// 裾の重い分布（自由度4のt分布に近い形）
const heavy = () => { const z = normal(); const c = Math.sqrt(rnd() * rnd() + 1e-12); return z / Math.max(c, 0.25) * 0.5 }

/** 運の形と幅を決めて、着順の同時分布を出す */
function simulate(race, noise, scale) {
  const n = 6
  const cnt2 = new Map()   // 2連単
  const cnt3 = new Map()   // 3連単
  const first = new Float64Array(n)
  const v = new Float64Array(n)
  const idx = [0, 1, 2, 3, 4, 5]
  for (let t = 0; t < NSIM; t++) {
    for (let i = 0; i < n; i++) v[i] = race.s[i] + noise(i) * scale(i)
    // 上位3つだけ取り出す
    let a = 0, b = -1, c = -1
    for (let i = 1; i < n; i++) if (v[i] > v[a]) a = i
    for (let i = 0; i < n; i++) if (i !== a && (b < 0 || v[i] > v[b])) b = i
    for (let i = 0; i < n; i++) if (i !== a && i !== b && (c < 0 || v[i] > v[c])) c = i
    first[a]++
    const k2 = `${race.lanes[a]}-${race.lanes[b]}`
    cnt2.set(k2, (cnt2.get(k2) ?? 0) + 1)
    const k3 = `${k2}-${race.lanes[c]}`
    cnt3.set(k3, (cnt3.get(k3) ?? 0) + 1)
  }
  return { first, cnt2, cnt3 }
}
const NOISE = {
  'ガンベル（いまと同じ）': { f: () => gumbel(), s: () => 1 },
  '正規': { f: () => normal(), s: () => 1 },
  '正規・幅0.8': { f: () => normal(), s: () => 0.8 },
  '正規・幅1.3': { f: () => normal(), s: () => 1.3 },
  '裾の重い分布': { f: () => heavy(), s: () => 1 },
  'ガンベル・外枠ほど運が大きい': { f: () => gumbel(), s: (i) => 1 + i * 0.12 },
  'ガンベル・外枠ほど運が小さい': { f: () => gumbel(), s: (i) => 1 - i * 0.08 },
  '正規・外枠ほど運が大きい': { f: () => normal(), s: (i) => 1 + i * 0.12 },
}
console.log('  運の形                       1着1点  2連単1点 2連単4点 3連単1点 3連単6点  2着(1着既知)')
for (const [nm, cfg] of Object.entries(NOISE)) {
  let n = 0, h1 = 0, t1 = 0, t4 = 0, s1 = 0, s6 = 0, c2n = 0, c2h = 0
  for (const r of races) {
    const sim = simulate(r, cfg.f, cfg.s)
    n++
    let bi = 0; for (let i = 1; i < 6; i++) if (sim.first[i] > sim.first[bi]) bi = i
    if (r.lanes[bi] === r.w[1]) h1++
    const truth2 = `${r.w[1]}-${r.w[2]}`, truth3 = `${r.w[1]}-${r.w[2]}-${r.w[3]}`
    const a2 = [...sim.cnt2].sort((x, y) => y[1] - x[1])
    const a3 = [...sim.cnt3].sort((x, y) => y[1] - x[1])
    if (a2[0]?.[0] === truth2) t1++
    if (a2.slice(0, 4).some(([k]) => k === truth2)) t4++
    if (a3[0]?.[0] === truth3) s1++
    if (a3.slice(0, 6).some(([k]) => k === truth3)) s6++
    // 1着を知っている前提の2着
    const c = a2.filter(([k]) => Number(k.slice(0, k.indexOf('-'))) === r.w[1])
    if (c.length) { c2n++; if (c[0][0] === truth2) c2h++ }
  }
  console.log(`  ${nm.padEnd(28)} ${(h1 / n * 100).toFixed(2).padStart(6)}% ${(t1 / n * 100).toFixed(2).padStart(7)}% ${(t4 / n * 100).toFixed(2).padStart(7)}% ${(s1 / n * 100).toFixed(2).padStart(7)}% ${(s6 / n * 100).toFixed(2).padStart(7)}% ${(c2h / c2n * 100).toFixed(2).padStart(11)}%`)
}
db.close()
