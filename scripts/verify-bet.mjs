// 「回収率100%超」が本物か偶然かを確かめる。
//
//   node scripts/verify-bet.mjs
//
// ★なぜ必要か
//   混合期待値1.0以上という買い方で回収率279%が出た。だが3連単は配当の偏りが極端で、
//   1,207点のうち的中43本、そのうち数本が万舟なら、それだけで全体が跳ね上がる。
//   「たまたま高配当を引いた」のか「本当に見つけている」のかは、平均値を見ても分からない。
//
// ★確かめ方
//   1. 配当の内訳を見る。上位数本を除いたら回収率がどうなるか
//   2. ブートストラップ。同じ買い目から復元抽出を1万回繰り返し、回収率の散らばりを見る
//   3. 期間を前半・後半に割り、両方で100%を超えるか
//   4. 場・グレードなど別の切り口でも安定しているか
//   どれか1つでも崩れたら、その戦略は使えない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)

const winCombo = new Map()
for (const r of all(`SELECT race_id, combo FROM payouts WHERE bet_type='sanrentan'`)) winCombo.set(r.race_id, r.combo)
const lg = (q) => { const v = Math.min(Math.max(q, 1e-7), 1 - 1e-7); return Math.log(v / (1 - v)) }

function load(split) {
  const om = new Map()
  for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
    JOIN pred q ON q.race_id=o.race_id AND q.lane=1 AND q.split=? WHERE o.odds IS NOT NULL`, split)) {
    let m = om.get(r.race_id); if (!m) { m = new Map(); om.set(r.race_id, m) }
    m.set(r.combo, r.odds)
  }
  const mdl = new Map()
  for (const r of all(`SELECT race_id, combo, p FROM pred3 WHERE split=?`, split)) {
    let m = mdl.get(r.race_id); if (!m) { m = new Map(); mdl.set(r.race_id, m) }
    m.set(r.combo, r.p)
  }
  const dates = new Map(all(`SELECT race_id, date, jcd, grade FROM races`).map((r) => [r.race_id, r]))
  const out = []
  for (const [rid, m] of om) {
    const pm = mdl.get(rid); if (!pm || m.size < 100) continue
    let tot = 0
    for (const [, o] of m) tot += 1 / o
    const w = winCombo.get(rid)
    const meta = dates.get(rid)
    const rows = []
    for (const [c, o] of m) {
      const mp2 = pm.get(c); if (mp2 == null) continue
      rows.push({ rid, combo: c, odds: o, mp: (1 / o) / tot, mdl: mp2, hit: c === w ? 1 : 0,
        date: meta?.date, jcd: meta?.jcd, grade: meta?.grade })
    }
    if (rows.length >= 100) out.push(rows)
  }
  return out
}

const calib = load('calib'), test = load('test')

// 混ぜ方は補正期間で決める（検証期間は使わない）
function fitBlend(races) {
  const rows = races.flat()
  const w = new Float64Array(3); w[1] = 1
  const m = new Float64Array(3), v = new Float64Array(3)
  for (let ep = 1; ep <= 300; ep++) {
    const g = new Float64Array(3)
    for (const r of rows) {
      const q = 1 / (1 + Math.exp(-(w[0] + w[1] * lg(r.mp) + w[2] * lg(r.mdl))))
      const d = q - r.hit
      g[0] += d; g[1] += d * lg(r.mp); g[2] += d * lg(r.mdl)
    }
    for (let i = 0; i < 3; i++) {
      const gi = g[i] / rows.length
      m[i] = 0.9 * m[i] + 0.1 * gi; v[i] = 0.999 * v[i] + 0.001 * gi * gi
      w[i] -= 0.03 * (m[i] / (1 - 0.9 ** ep)) / (Math.sqrt(v[i] / (1 - 0.999 ** ep)) + 1e-8)
    }
  }
  return w
}
const W = fitBlend(calib)
console.log(`混ぜ方: 定数 ${W[0].toFixed(3)}  市場 ${W[1].toFixed(3)}  モデル ${W[2].toFixed(3)}\n`)

// 検証期間の買い目を作る
const picks = []
for (const rows of test) {
  let s = 0
  const q = rows.map((r) => { const x = 1 / (1 + Math.exp(-(W[0] + W[1] * lg(r.mp) + W[2] * lg(r.mdl)))); s += x; return x })
  rows.forEach((r, i) => { r.bp = q[i] / s; r.ev = r.bp * r.odds })
  for (const r of rows) if (r.ev >= 1.0) picks.push(r)
}
const roi = (a) => a.reduce((x, r) => x + r.hit * r.odds, 0) / a.length
console.log(`=== 混合期待値1.0以上 ===`)
console.log(`  買い目 ${picks.length}点  的中 ${picks.filter((r) => r.hit).length}本  回収率 ${(roi(picks) * 100).toFixed(1)}%`)

// 1. 高配当の寄与
const hits = picks.filter((r) => r.hit).sort((a, b) => b.odds - a.odds)
console.log(`\n【1】的中の内訳（配当が大きい順に10本）`)
console.log('  ' + hits.slice(0, 10).map((r) => `${r.odds.toFixed(1)}倍`).join(' / '))
const total = picks.reduce((x, r) => x + r.hit * r.odds, 0)
for (const k of [1, 2, 3, 5]) {
  const cut = hits.slice(0, k).reduce((x, r) => x + r.odds, 0)
  console.log(`  上位${k}本を除くと回収率 ${(((total - cut) / picks.length) * 100).toFixed(1)}%`)
}

// 2. ブートストラップ
console.log(`\n【2】ブートストラップ（買い目を復元抽出して1万回やり直す）`)
const vals = picks.map((r) => r.hit * r.odds)
const boot = []
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
for (let b = 0; b < 10000; b++) {
  let s = 0
  for (let i = 0; i < vals.length; i++) s += vals[(rnd() * vals.length) | 0]
  boot.push(s / vals.length)
}
boot.sort((a, b) => a - b)
const pct = (q) => boot[Math.floor(q * boot.length)]
console.log(`  中央値 ${(pct(0.5) * 100).toFixed(1)}%   90%区間 [${(pct(0.05) * 100).toFixed(1)}%, ${(pct(0.95) * 100).toFixed(1)}%]`)
console.log(`  100%を下回った割合 ${((boot.filter((x) => x < 1).length / boot.length) * 100).toFixed(1)}%`)

// 3. 期間を割る
console.log(`\n【3】期間を前半・後半に割る`)
const ds = [...new Set(picks.map((r) => r.date))].sort()
const mid = ds[Math.floor(ds.length / 2)]
for (const [nm, a] of [['前半', picks.filter((r) => r.date < mid)], ['後半', picks.filter((r) => r.date >= mid)]]) {
  if (!a.length) continue
  console.log(`  ${nm} ${String(a.length).padStart(5)}点  的中${String(a.filter((r) => r.hit).length).padStart(3)}本  回収率 ${(roi(a) * 100).toFixed(1)}%`)
}

// 4. 別の切り口
console.log(`\n【4】グレード別`)
const byG = new Map()
for (const r of picks) { let a = byG.get(r.grade); if (!a) { a = []; byG.set(r.grade, a) } a.push(r) }
for (const [g, a] of [...byG].sort((x, y) => y[1].length - x[1].length))
  if (a.length >= 30) console.log(`  ${String(g).padEnd(8)} ${String(a.length).padStart(5)}点  的中${String(a.filter((r) => r.hit).length).padStart(3)}本  回収率 ${(roi(a) * 100).toFixed(1)}%`)

console.log(`\n※ ブートストラップの下限が100%を割る、または前後半のどちらかが100%を割る場合、`)
console.log(`   その回収率は偶然の可能性が高い。実運用に回してはいけない。`)
db.close()
