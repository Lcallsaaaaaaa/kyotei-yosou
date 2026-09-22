// オッズから確率を作る方法を比べる。
//
//   node --max-old-space-size=5120 scripts/oddsprob.mjs --t wi1
//
// ★いままで使っていた方法（単純正規化）
//   p_i = (1/オッズ_i) ÷ Σ(1/オッズ)
//   控除率25%を全艇に均等に配る形。本命・穴の歪み（本命は買われ足りず、穴は買われすぎ）を無視する。
//
// ★べき乗法（power method）
//   p_i ∝ (1/オッズ_i)^k として、Σp=1 になる k を解く。
//   k>1 なら本命をより厚く、k<1 なら穴を厚く見る。本命穴バイアスをそのまま表せる。
//   Clarke(2017)の比較では単純正規化より普遍的に優れるとされる。
//
// ★Shin法
//   「内部情報を持つ客が割合zいる」と仮定して控除を取り除く。低オッズ側により強く効く。
//     p_i ∝ ( sqrt(z^2 + 4(1-z) r_i^2 / R) - z ) / (2(1-z))   （r=1/オッズ, R=Σr）
//
// ★何で良し悪しを測るか
//   的中率ではなく**確率の正確さ**（対数損失・ブライア）で測る。
//   1着を当てるだけなら順位が同じなのでどの方法でも同じ。混ぜるときに効いてくる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wi1')

const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let m = O.get(r.race_id); if (!m) { m = {}; O.set(r.race_id, m) }
  m[r.lane] = r.tansho
}
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  const o = O.get(rid); if (!o) continue
  const od = bs.map((b) => o[b.lane])
  if (od.some((v) => !(v > 0))) continue
  rs.push({ od, p: bs.map((b) => b.p), y: bs.map((b) => b.y), lane: bs.map((b) => b.lane) })
}
const N = rs.length
console.log(`${N.toLocaleString()}レース\n`)

const norm = (od) => { const r = od.map((v) => 1 / v); const s = r.reduce((a, b) => a + b, 0); return r.map((v) => v / s) }
/** べき乗法：Σ (1/o)^k = 1 になる k を二分探索で解く */
const power = (od) => {
  const r = od.map((v) => 1 / v)
  let lo = 0.3, hi = 3
  for (let it = 0; it < 60; it++) {
    const k = (lo + hi) / 2
    const s = r.reduce((a, v) => a + v ** k, 0)
    if (s > 1) lo = k; else hi = k
  }
  const k = (lo + hi) / 2
  const q = r.map((v) => v ** k)
  const s = q.reduce((a, b) => a + b, 0)
  return q.map((v) => v / s)
}
/** Shin法：Σ p = 1 になる z を二分探索で解く */
const shin = (od) => {
  const r = od.map((v) => 1 / v)
  const Rs = r.reduce((a, b) => a + b, 0)
  const f = (z) => r.reduce((a, v) => a + (Math.sqrt(z * z + 4 * (1 - z) * v * v / Rs) - z) / (2 * (1 - z)), 0)
  let lo = 1e-6, hi = 0.6
  for (let it = 0; it < 60; it++) { const z = (lo + hi) / 2; if (f(z) > 1) lo = z; else hi = z }
  const z = (lo + hi) / 2
  const q = r.map((v) => (Math.sqrt(z * z + 4 * (1 - z) * v * v / Rs) - z) / (2 * (1 - z)))
  const s = q.reduce((a, b) => a + b, 0)
  return { p: q.map((v) => v / s), z }
}

const score = (fn, name) => {
  let ll = 0, br = 0, hit = 0, zs = 0
  for (const r of rs) {
    const out = fn(r.od)
    const q = out.p ?? out
    if (out.z != null) zs += out.z
    let bi = 0
    for (let i = 1; i < 6; i++) if (q[i] > q[bi]) bi = i
    if (r.y[bi] === 1) hit++
    for (let i = 0; i < 6; i++) { br += (q[i] - r.y[i]) ** 2; if (r.y[i] === 1) ll -= Math.log(Math.max(q[i], 1e-9)) }
  }
  console.log(`  ${name.padEnd(16)} 対数損失 ${(ll / N).toFixed(5)}　ブライア ${(br / N).toFixed(5)}　1着的中 ${(hit / N * 100).toFixed(2)}%${out0(zs, name)}`)
}
const out0 = (zs, name) => name.startsWith('Shin') ? `　平均z ${(zs / N).toFixed(4)}` : ''
console.log('市場のオッズを確率に直す方法（小さいほど正確）')
score(norm, '単純正規化')
score(power, 'べき乗法')
score(shin, 'Shin法')
// モデル自身
{
  let ll = 0, br = 0, hit = 0
  for (const r of rs) {
    let bi = 0; for (let i = 1; i < 6; i++) if (r.p[i] > r.p[bi]) bi = i
    if (r.y[bi] === 1) hit++
    for (let i = 0; i < 6; i++) { br += (r.p[i] - r.y[i]) ** 2; if (r.y[i] === 1) ll -= Math.log(Math.max(r.p[i], 1e-9)) }
  }
  console.log(`  ${'モデル'.padEnd(16)} 対数損失 ${(ll / N).toFixed(5)}　ブライア ${(br / N).toFixed(5)}　1着的中 ${(hit / N * 100).toFixed(2)}%`)
}

// 混ぜ直す
console.log('\nモデルと混ぜたとき（α=1固定でβを振る）')
const L = (x) => Math.log(Math.max(x, 1e-9))
for (const [nm, fn] of [['単純正規化', norm], ['べき乗法', power], ['Shin法', (o) => shin(o).p]]) {
  const Q = rs.map((r) => fn(r.od))
  let best = null
  for (let b = 0; b <= 2.0001; b += 0.1) {
    let h = 0, ll = 0
    for (let j = 0; j < N; j++) {
      const r = rs[j], q = Q[j]
      const s = [...Array(6)].map((_, i) => L(r.p[i]) + b * L(q[i]))
      const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
      const t = ex.reduce((x, y) => x + y, 0)
      let bi = 0; for (let i = 1; i < 6; i++) if (ex[i] > ex[bi]) bi = i
      if (r.y[bi] === 1) h++
      for (let i = 0; i < 6; i++) if (r.y[i] === 1) ll -= Math.log(Math.max(ex[i] / t, 1e-9))
    }
    if (!best || h > best.h) best = { b, h, ll }
  }
  console.log(`  ${nm.padEnd(10)} 最良β=${best.b.toFixed(1)}　1着的中 ${(best.h / N * 100).toFixed(2)}%　対数損失 ${(best.ll / N).toFixed(5)}`)
}
db.close()
