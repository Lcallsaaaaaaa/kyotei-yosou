// 市場とモデルを混ぜて、実際に買える戦略を作る。
//
//   node scripts/bet.mjs
//
// ★これまでに分かったこと
//   1. 市場（オッズ）は自分のモデルより強い（logloss 0.3124 vs 0.3192）
//   2. だがモデルは市場が知らない情報を26%ぶん持っている
//        「実際に1着か」を両方で説明させると 市場0.782 / モデル0.263
//   3. 市場には強いクセがある。人気薄ほど回収率が悪い
//        万舟帯42.5% → 本命帯78.4%（控除率25%＝平均74.8%）
//   4. 自分が最初に試した「期待値1.0以上を買う」は、モデルの確率が市場より高い組
//      ＝人気薄を拾うフィルタで、最悪の帯を狙い撃ちしていた（回収率73.1%）
//
// ★だからこうする
//   市場の確率を土台にし、モデルの情報で微修正する。混ぜ方は**補正期間だけ**で決める。
//   混ぜるのは組み合わせ単位。3連単のオッズには2着3着の情報も入っているが、
//   モデルは1着しか予測していないので、組単位で混ぜた方が市場の情報を活かせる。
//
// ★検証期間は買い方を決めるのに一切使わない
//   使うと「その期間でうまくいく買い方」を選んだだけになり、実力を測れない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)

const winCombo = new Map()
for (const r of all(`SELECT race_id, combo FROM payouts WHERE bet_type='sanrentan'`)) winCombo.set(r.race_id, r.combo)

/** 指定した区分のレースを、120通りの {市場確率, モデル確率, オッズ, 的中} に展開する */
function load(split) {
  const pred = new Map()
  for (const r of all(`SELECT race_id, lane, p FROM pred WHERE split=?`, split)) {
    let g = pred.get(r.race_id); if (!g) { g = new Array(7).fill(0); pred.set(r.race_id, g) }
    g[r.lane] = r.p
  }
  const om = new Map()
  for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
    JOIN pred q ON q.race_id=o.race_id AND q.lane=1 AND q.split=? WHERE o.odds IS NOT NULL`, split)) {
    let m = om.get(r.race_id); if (!m) { m = new Map(); om.set(r.race_id, m) }
    m.set(r.combo, r.odds)
  }
  const out = []
  for (const [rid, m] of om) {
    const p = pred.get(rid); if (!p || m.size < 100) continue
    let tot = 0
    for (const [, o] of m) tot += 1 / o
    const w = winCombo.get(rid)
    const rows = []
    for (const [c, o] of m) {
      const [a, b, d] = c.split('-').map(Number)
      const r1 = 1 - p[a], r2 = 1 - p[a] - p[b]
      if (r1 <= 1e-9 || r2 <= 1e-9) continue
      rows.push({ rid, combo: c, odds: o, mp: (1 / o) / tot, mdl: p[a] * (p[b] / r1) * (p[d] / r2), hit: c === w ? 1 : 0 })
    }
    if (rows.length >= 100) out.push(rows)
  }
  return out
}

const calib = load('calib')
const test = load('test')
console.log(`補正 ${calib.length.toLocaleString()}レース / 検証 ${test.length.toLocaleString()}レース\n`)

// ---------- 混ぜ方を補正期間で決める ----------
const lg = (q) => { const v = Math.min(Math.max(q, 1e-7), 1 - 1e-7); return Math.log(v / (1 - v)) }
function fitBlend(races) {
  const rows = races.flat()
  const w = new Float64Array(3)
  w[1] = 1
  const m = new Float64Array(3), v = new Float64Array(3)
  for (let ep = 1; ep <= 300; ep++) {
    const g = new Float64Array(3)
    for (const r of rows) {
      const z = w[0] + w[1] * lg(r.mp) + w[2] * lg(r.mdl)
      const q = 1 / (1 + Math.exp(-z))
      const d = q - r.hit
      g[0] += d; g[1] += d * lg(r.mp); g[2] += d * lg(r.mdl)
    }
    for (let i = 0; i < 3; i++) {
      const gi = g[i] / rows.length
      m[i] = 0.9 * m[i] + 0.1 * gi
      v[i] = 0.999 * v[i] + 0.001 * gi * gi
      w[i] -= 0.03 * (m[i] / (1 - 0.9 ** ep)) / (Math.sqrt(v[i] / (1 - 0.999 ** ep)) + 1e-8)
    }
  }
  return w
}
const W = fitBlend(calib)
console.log(`混ぜ方（補正期間で決定）: 定数 ${W[0].toFixed(3)}  市場 ${W[1].toFixed(3)}  モデル ${W[2].toFixed(3)}`)
if (Math.abs(W[2]) < 0.05) console.log('  ⚠️ モデルの係数がほぼ0。組み合わせ単位では市場に何も足せていない')

const blend = (races) => races.map((rows) => {
  let s = 0
  const out = rows.map((r) => {
    const q = 1 / (1 + Math.exp(-(W[0] + W[1] * lg(r.mp) + W[2] * lg(r.mdl))))
    s += q
    return { ...r, bp: q }
  })
  for (const r of out) r.bp /= s   // 120通りの合計を1にする
  return out
})
const testB = blend(test)

// ---------- 戦略ごとの回収率 ----------
// ★本命帯に絞る条件を必ず入れる。人気薄帯は市場のクセで回収率が壊滅的なため。
const strategies = []
for (const ev of [1.0, 1.05, 1.1, 1.2, 1.3]) {
  strategies.push({ name: `混合期待値${ev}以上`, f: (r) => r.bp * r.odds >= ev })
  for (const mp of [0.01, 0.02, 0.05, 0.1])
    strategies.push({ name: `混合期待値${ev}以上 かつ市場確率${(mp * 100).toFixed(0)}%以上`, f: (r) => r.bp * r.odds >= ev && r.mp >= mp })
}
strategies.push({ name: '混合確率が最大の1点', f: null, top: 1 })
strategies.push({ name: '混合確率が高い順3点', f: null, top: 3 })
strategies.push({ name: '混合確率が高い順5点', f: null, top: 5 })
// 比較用：市場だけで買う（モデルを使わない）
strategies.push({ name: '【比較】市場の1番人気1点', f: null, topMarket: 1 })
strategies.push({ name: '【比較】市場の人気上位3点', f: null, topMarket: 3 })

const res = strategies.map((s) => ({ ...s, bet: 0, back: 0, hit: 0, races: 0 }))
for (const rows of testB) {
  const byBp = [...rows].sort((a, b) => b.bp - a.bp)
  const byMp = [...rows].sort((a, b) => b.mp - a.mp)
  for (const s of res) {
    const picks = s.top ? byBp.slice(0, s.top) : s.topMarket ? byMp.slice(0, s.topMarket) : rows.filter(s.f)
    if (!picks.length) continue
    s.races++
    for (const r of picks) { s.bet += 100; if (r.hit) { s.back += r.odds * 100; s.hit++ } }
  }
}
console.log('\n=== 回収率（検証期間・買い方は補正期間だけで決定） ===')
console.log('  戦略                                        レース    点数     的中   的中率   回収率')
res.sort((a, b) => (b.bet ? b.back / b.bet : 0) - (a.bet ? a.back / a.bet : 0))
for (const s of res) {
  if (!s.bet) { console.log(`  ${s.name.padEnd(40)} 該当なし`); continue }
  const roi = (s.back / s.bet) * 100
  const pts = s.bet / 100
  console.log(`  ${s.name.padEnd(40)} ${String(s.races).padStart(7)} ${String(pts).padStart(8)} ${String(s.hit).padStart(6)} ${((s.hit / pts) * 100).toFixed(2).padStart(6)}% ${roi.toFixed(1).padStart(7)}%`)
}
console.log('\n※ 締切後の確定オッズを使っているため、実際の回収率はこれより低い。')
console.log('※ 100%を明確に超えないものは、売り物にしてはいけない。')
db.close()
