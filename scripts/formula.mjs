// 計算式そのものを見せる。どの項目にどの係数が掛かっているか。
//
//   node --max-old-space-size=8192 scripts/formula.mjs
//   node --max-old-space-size=8192 scripts/formula.mjs --race 20260824-24-09
//
// ★出すもの
//   ① 式の形（項目 × 係数 を足す、それだけ）
//   ② 係数の大きい項目トップ30（1着用・2着用・3着用それぞれ）
//   ③ 実際の1レースで、各艇の点数がどう積み上がったか
//
// ★walk.mjs は係数を保存していないので、ここで学習し直して取り出す。
//   学習期間は最後の検証月の直前まで（walk.mjs と同じ切り方）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const FROM = flag('from', '2025-09-01')     // 学習に使う開始日（軽くするため1年弱）
const UNTIL = flag('until', '2026-08-01')   // ここより前で学習
const SHOW = flag('race', null)

const featCols = db.prepare(`PRAGMA table_info(feat)`).all().map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !/^(waveb_|windb_|nami5_|wl_|wake_)/.test(c))
const rfeatCols = db.prepare(`PRAGMA table_info(rfeat)`).all().map((c) => c.name)
  .filter((c) => c !== 'race_id' && c !== 'lane')
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
const laneCols = [1, 2, 3, 4, 5, 6].map((c) => `枠${c}号艇`)
const NAMES = [...featCols, ...rfeatCols, ...progCols, ...laneCols]
const D = NAMES.length
console.log(`項目 ${D} 個（艇単位${featCols.length} + レース単位${rfeatCols.length} + 番組表${progCols.length} + 枠番6）\n`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const SQL = `
  SELECT f.race_id, f.lane, r.date, e.rank_num,
    ${progCols.map((c) => `p.${q(c)}`).join(', ')},
    ${featCols.map((c) => `f.${q(c)}`).join(', ')},
    ${rfeatCols.map((c) => `rf.${q(c)}`).join(', ')}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  LEFT JOIN rfeat rf ON rf.race_id = f.race_id AND rf.lane = f.lane
  WHERE r.date >= '${FROM}'
  ORDER BY r.date, f.race_id, f.lane`

const vec = (r) => {
  const v = new Float32Array(D)
  let k = 0
  for (const c of featCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of rfeatCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of progCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  if (r.lane >= 1 && r.lane <= 6) v[k + r.lane - 1] = 1
  return v
}

const races = []
{
  let cur = null, n = 0
  for (const r of db.prepare(SQL).iterate()) {
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), lane: r.lane, rank: r.rank_num, raw: r })
    n++
  }
  console.log(`${n.toLocaleString()} 行 / ${races.length.toLocaleString()} レース`)
}
// 1〜3着がそろったレースだけ
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
for (const g of races) { const m = ORD.get(g.race_id); g.ord = m && m[1] && m[2] && m[3] ? [m[1], m[2], m[3]] : null }
const usable = races.filter((g) => g.boats.length === 6 && g.ord)

// 標準化（平均0・幅1にそろえる）
const mean = new Float64Array(D), sd = new Float64Array(D)
{
  let n = 0
  for (const g of usable) for (const b of g.boats) { for (let d = 0; d < D; d++) mean[d] += b.x[d]; n++ }
  for (let d = 0; d < D; d++) mean[d] /= n
  for (const g of usable) for (const b of g.boats) for (let d = 0; d < D; d++) sd[d] += (b.x[d] - mean[d]) ** 2
  for (let d = 0; d < D; d++) { sd[d] = Math.sqrt(sd[d] / n); if (!(sd[d] > 1e-9)) sd[d] = 1 }
  for (const g of usable) for (const b of g.boats) {
    b.z = new Float32Array(D)
    for (let d = 0; d < D; d++) b.z[d] = (b.x[d] - mean[d]) / sd[d]
  }
}

const tr = usable.filter((g) => g.date < UNTIL)
console.log(`学習 ${tr.length.toLocaleString()} レース（${FROM} 〜 ${UNTIL}）\n`)

// ---------- 学習（walk.mjs と同じ形） ----------
function fit(rs, { lr = 0.25, epochs = 60, l2 = 3e-4 } = {}) {
  const W = [0, 1, 2].map(() => new Float64Array(D))
  const M = [0, 1, 2].map(() => new Float64Array(D))
  const V = [0, 1, 2].map(() => new Float64Array(D))
  for (let ep = 1; ep <= epochs; ep++) {
    const G = [0, 1, 2].map(() => new Float64Array(D))
    for (const g of rs) {
      const bs = g.boats, idx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      for (let st = 0; st < 3; st++) {
        const w = W[st], gr = G[st]
        const cand = []; for (let i = 0; i < 6; i++) if (!gone.has(i)) cand.push(i)
        const s = cand.map((i) => { let z = 0; const x = bs[i].z; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z })
        const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
        const sum = ex.reduce((a, b) => a + b, 0)
        const pick = idx.get(g.ord[st]); if (pick === undefined) break
        for (let k = 0; k < cand.length; k++) {
          const p = ex[k] / sum, x = bs[cand[k]].z
          const c = cand[k] === pick ? p - 1 : p
          for (let d = 0; d < D; d++) gr[d] += c * x[d]
        }
        gone.add(pick)
      }
    }
    const n = rs.length
    for (let st = 0; st < 3; st++) for (let d = 0; d < D; d++) {
      const gi = G[st][d] / n + l2 * W[st][d]
      M[st][d] = 0.9 * M[st][d] + 0.1 * gi
      V[st][d] = 0.999 * V[st][d] + 0.001 * gi * gi
      W[st][d] -= lr * (M[st][d] / (1 - 0.9 ** ep)) / (Math.sqrt(V[st][d] / (1 - 0.999 ** ep)) + 1e-8)
    }
    if (ep % 20 === 0) console.log(`  学習 ${ep}/${epochs}`)
  }
  return W
}
const W = fit(tr)

// ---------- ① 式の形 ----------
console.log(`
════ 式の形 ════

  各艇の点数 =  項目1 × 係数1
              + 項目2 × 係数2
              + ...
              + 項目${D} × 係数${D}

  1着になる確率 = exp(その艇の点数) ÷ ( 6艇ぶんの exp(点数) の合計 )

  ※ 係数は1着用・2着用・3着用の3組ある（合計 ${D * 3} 個）
  ※ 項目は「平均を引いて幅で割った」値。係数の大きさをそのまま比べられる
`)

// ---------- ② 係数の大きい項目 ----------
const ST = ['1着を選ぶ', '2着を選ぶ', '3着を選ぶ']
for (let st = 0; st < 3; st++) {
  const rank = NAMES.map((n, d) => ({ n, d, w: W[st][d] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 15)
  console.log(`\n════ ② ${ST[st]}ときに効いている項目 上位15 ════`)
  console.log('  係数      項目                          向き')
  for (const r of rank)
    console.log(`  ${r.w >= 0 ? '+' : ''}${r.w.toFixed(4).padStart(8)}  ${r.n.padEnd(28)} ${r.w > 0 ? '大きいほど上位' : '大きいほど下位'}`)
}

// ---------- ③ 1レースの実例 ----------
const target = SHOW ? usable.find((g) => g.race_id === SHOW)
  : usable.filter((g) => g.date >= UNTIL).slice(-1)[0] ?? usable[usable.length - 1]
if (target) {
  console.log(`\n════ ③ 実例：${target.race_id}（${target.date}）════`)
  const sc = target.boats.map((b) => {
    let z = 0; for (let d = 0; d < D; d++) z += W[0][d] * b.z[d]
    return z
  })
  const mx = Math.max(...sc), ex = sc.map((v) => Math.exp(v - mx))
  const sum = ex.reduce((a, b) => a + b, 0)
  console.log('  艇   点数      1着確率   実際')
  target.boats.forEach((b, i) => {
    console.log(`  ${b.lane}号艇 ${sc[i].toFixed(3).padStart(8)} ${(ex[i] / sum * 100).toFixed(1).padStart(8)}%   ${b.rank ?? '-'}着`)
  })
  // 1号艇の内訳
  const b0 = target.boats.find((b) => b.lane === 1) ?? target.boats[0]
  const cont = NAMES.map((n, d) => ({ n, v: b0.x[d], z: b0.z[d], w: W[0][d], c: W[0][d] * b0.z[d] }))
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 12)
  console.log(`\n  ${b0.lane}号艇の点数の内訳（寄与の大きい順・上位12）`)
  console.log('  項目                          元の値      標準化      係数      寄与')
  for (const c of cont)
    console.log(`  ${c.n.padEnd(28)} ${String(c.v == null ? '-' : Number(c.v).toFixed(2)).padStart(9)} ${c.z.toFixed(2).padStart(10)} ${c.w.toFixed(3).padStart(9)} ${(c.c >= 0 ? '+' : '') + c.c.toFixed(3)}`)
  const tot = NAMES.reduce((a, n, d) => a + W[0][d] * b0.z[d], 0)
  console.log(`  上位12の合計 ${cont.reduce((a, c) => a + c.c, 0).toFixed(3)} ／ 全${D}項目の合計 ${tot.toFixed(3)}`)
}
db.close()
