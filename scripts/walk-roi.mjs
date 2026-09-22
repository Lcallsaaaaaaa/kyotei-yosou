// 歩進検証の予想で、実際に儲かるのかを月ごとに測る。
//
//   node scripts/walk-roi.mjs
//
// ★前回の検証と何が違うか
//   1. 進入コースを使うのをやめた（締切後にしか決まらない。使うと成績が実際より良く出る）
//   2. モデルを月ごとに作り直した（walk.mjs）。特定の期間に合っただけの可能性を排除
//   3. **混ぜ方も月ごとに作り直す**。前回は補正期間で1回決めた混ぜ方を使い、
//      さらに検証期間の成績を見て約20戦略から良いものを選んでいた。それでは
//      「その期間でうまくいく買い方」を選んだだけで、実力を測ったことにならない。
//      ここでは各月について「その月より前のオッズだけ」で混ぜ方を決める。
//
// ★それでも残る限界
//   締切後の確定オッズを使っている。実際に買うのは締切前。
//   中穴は締切直前に資金が動くので、ここが最も危うい仮定。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'walk1'), T3 = flag('t3', 'walk3')
console.log(`使うテーブル: ${T1} / ${T3}`)
const lg = (q) => { const v = Math.min(Math.max(q, 1e-7), 1 - 1e-7); return Math.log(v / (1 - v)) }

const winCombo = new Map()
for (const r of all(`SELECT race_id, combo FROM payouts WHERE bet_type='sanrentan'`)) winCombo.set(r.race_id, r.combo)

// 月ごとにレースを組み立てる
console.log('読み込み中...')
const byMonth = new Map()
{
  const odds = new Map()
  for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
    WHERE o.odds IS NOT NULL AND EXISTS (SELECT 1 FROM ${T1} w WHERE w.race_id=o.race_id AND w.lane=1)`)) {
    let m = odds.get(r.race_id); if (!m) { m = new Map(); odds.set(r.race_id, m) }
    m.set(r.combo, r.odds)
  }
  const mdl = new Map()
  for (const r of all(`SELECT race_id, combo, p, month FROM ${T3}`)) {
    let m = mdl.get(r.race_id); if (!m) { m = { month: r.month, c: new Map() }; mdl.set(r.race_id, m) }
    m.c.set(r.combo, r.p)
  }
  for (const [rid, om] of odds) {
    const g = mdl.get(rid); if (!g || om.size < 100 || g.c.size < 100) continue
    let tot = 0
    for (const [, o] of om) tot += 1 / o
    const w = winCombo.get(rid)
    const rows = []
    for (const [c, o] of om) {
      const p = g.c.get(c); if (p == null) continue
      rows.push({ combo: c, odds: o, mp: (1 / o) / tot, mdl: p, hit: c === w ? 1 : 0 })
    }
    if (rows.length < 100) continue
    let a = byMonth.get(g.month); if (!a) { a = []; byMonth.set(g.month, a) }
    a.push(rows)
  }
}
const months = [...byMonth.keys()].sort()
console.log(`オッズが揃っている月: ${months.join(' / ')}`)
for (const m of months) console.log(`  ${m}  ${byMonth.get(m).length.toLocaleString()}レース`)

function fitBlend(races) {
  const rows = races.flat()
  const w = new Float64Array(3); w[1] = 1
  const m = new Float64Array(3), v = new Float64Array(3)
  for (let ep = 1; ep <= 250; ep++) {
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

// ---------- 月ごと：その月より前だけで混ぜ方を決め、その月で買う ----------
console.log('\n=== 月ごとの回収率（混ぜ方はその月より前のオッズだけで決定） ===')
console.log('  月        レース   混ぜ方(市場/モデル)   買い目   的中   回収率')
const allPicks = []
for (let i = 1; i < months.length; i++) {
  const mo = months[i]
  const prior = months.slice(0, i).flatMap((m) => byMonth.get(m))
  if (prior.length < 1000) { console.log(`  ${mo}  学習用の月が足りない`); continue }
  const W = fitBlend(prior)
  const picks = []
  for (const rows of byMonth.get(mo)) {
    let s = 0
    const q = rows.map((r) => { const x = 1 / (1 + Math.exp(-(W[0] + W[1] * lg(r.mp) + W[2] * lg(r.mdl)))); s += x; return x })
    rows.forEach((r, k) => { r.bp = q[k] / s; r.ev = r.bp * r.odds })
    for (const r of rows) if (r.ev >= 1.0) { picks.push({ ...r, month: mo }) }
  }
  const roi = picks.length ? picks.reduce((a, r) => a + r.hit * r.odds, 0) / picks.length : 0
  allPicks.push(...picks)
  console.log(`  ${mo}  ${String(byMonth.get(mo).length).padStart(6)}    ${W[1].toFixed(3)} / ${W[2].toFixed(3)}      ${String(picks.length).padStart(5)}  ${String(picks.filter((r) => r.hit).length).padStart(4)}   ${(roi * 100).toFixed(1)}%`)
}

// ---------- 全体 ----------
const roi = (a) => (a.length ? a.reduce((x, r) => x + r.hit * r.odds, 0) / a.length : 0)
console.log(`\n=== 全期間まとめ ===`)
console.log(`  買い目 ${allPicks.length.toLocaleString()}点  的中 ${allPicks.filter((r) => r.hit).length}本  回収率 ${(roi(allPicks) * 100).toFixed(1)}%`)
if (!allPicks.length) { db.close(); process.exit(0) }

const hits = allPicks.filter((r) => r.hit).sort((a, b) => b.odds - a.odds)
console.log(`\n  配当が大きい順に10本: ${hits.slice(0, 10).map((r) => r.odds.toFixed(0) + '倍').join(' / ')}`)
const tot = allPicks.reduce((x, r) => x + r.hit * r.odds, 0)
for (const k of [1, 3, 5, 10]) {
  const cut = hits.slice(0, k).reduce((x, r) => x + r.odds, 0)
  console.log(`  上位${String(k).padStart(2)}本を除くと回収率 ${(((tot - cut) / allPicks.length) * 100).toFixed(1)}%`)
}

// ブートストラップ
let seed = 987654321
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const vals = allPicks.map((r) => r.hit * r.odds)
const boot = []
for (let b = 0; b < 10000; b++) {
  let s = 0
  for (let i = 0; i < vals.length; i++) s += vals[(rnd() * vals.length) | 0]
  boot.push(s / vals.length)
}
boot.sort((a, b) => a - b)
const pc = (q) => boot[Math.floor(q * boot.length)]
console.log(`\n  ブートストラップ 中央値 ${(pc(0.5) * 100).toFixed(1)}%  90%区間 [${(pc(0.05) * 100).toFixed(1)}%, ${(pc(0.95) * 100).toFixed(1)}%]`)
console.log(`  100%を下回った割合 ${((boot.filter((x) => x < 1).length / boot.length) * 100).toFixed(1)}%`)

console.log(`\n  オッズ帯     買い目   的中   回収率`)
for (const [lo, hi] of [[0, 20], [20, 50], [50, 100], [100, 300], [300, 1e9]]) {
  const s = allPicks.filter((r) => r.odds >= lo && r.odds < hi)
  if (s.length < 20) continue
  console.log(`  ${String(lo).padStart(4)}〜${hi === 1e9 ? '  ∞' : String(hi).padStart(4)}倍  ${String(s.length).padStart(6)}  ${String(s.filter((r) => r.hit).length).padStart(4)}   ${(roi(s) * 100).toFixed(1)}%`)
}
console.log('\n※ 締切後の確定オッズを使用。実際の回収率はこれより低くなる。')
db.close()
