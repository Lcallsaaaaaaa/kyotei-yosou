// 「単勝オッズ2倍以上で回収率100%超」が本物か偶然かを検定する。
//
//   node scripts/tansho-verify.mjs
//
// ★何を疑うか
//   オッズ帯を7分割して良い数字を探した。これは回収率279%を出したときと同じ構造。
//   あのときは (1) 締切後にしか分からない進入コースを使っていた
//              (2) 検証期間を見て20戦略から選んだ
//   という2つの誤りが重なっていた。同じ轍を踏んでいないか確認する。
//
// ★確かめること
//   1. 月ごとに分けても100%を超えるか（7ヶ月中いくつか）
//   2. ブートストラップで100%を下回る確率
//   3. 上位の高配当を除いても残るか
//   4. 閾値を動かしたとき滑らかに変化するか（跳ね値なら偶然）
//   5. 買い目の中身は何か（人気薄狙いに偏っていないか）
//
// ★この検証でも消えない限界
//   使っているのは締切後の確定オッズ。実際に買うのは締切前。
//   オッズ2.5倍以上の艇は締切直前に資金が入って下がる可能性がある。
//   それは別途「締切前オッズ」を集めないと確かめられない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'wd1')
const MIN = Number(flag('min', 2.0))

const rows = all(`
  SELECT w.race_id, w.lane, w.month, w.p, w.y, t.tansho AS odds
  FROM ${T1} w JOIN odds_tan t ON t.race_id = w.race_id AND t.lane = w.lane
  WHERE t.tansho IS NOT NULL AND t.tansho > 0`)
const byRace = new Map()
for (const r of rows) { let g = byRace.get(r.race_id); if (!g) { g = []; byRace.set(r.race_id, g) } g.push(r) }
// 各レースでモデルの本命だけを買う
const tops = []
for (const [, g] of byRace) tops.push(g.reduce((a, b) => (b.p > a.p ? b : a)))
console.log(`${byRace.size.toLocaleString()}レース / モデル本命 ${tops.length.toLocaleString()}点`)

const st = (a) => {
  if (!a.length) return null
  return { n: a.length, hit: a.reduce((x, r) => x + r.y, 0) / a.length,
    roi: a.reduce((x, r) => x + r.y * r.odds, 0) / a.length }
}
const sel = tops.filter((r) => r.odds >= MIN)
const S = st(sel)
console.log(`\n=== 条件：モデル本命の単勝オッズ ${MIN}倍以上 ===`)
console.log(`  ${S.n}点  的中 ${(S.hit * 100).toFixed(1)}%  回収 ${(S.roi * 100).toFixed(1)}%  1点あたり ${((S.roi - 1) * 100).toFixed(0)}円\n`)

// 1. 月別
console.log('【1】月別')
console.log('    月        点数   的中率   回収率')
const bm = new Map()
for (const r of sel) { let a = bm.get(r.month); if (!a) { a = []; bm.set(r.month, a) } a.push(r) }
let over = 0
for (const m of [...bm.keys()].sort()) {
  const t = st(bm.get(m))
  if (t.roi >= 1) over++
  console.log(`    ${m}  ${String(t.n).padStart(5)}   ${(t.hit * 100).toFixed(1).padStart(5)}%   ${(t.roi * 100).toFixed(1).padStart(6)}%${t.roi >= 1 ? ' ★' : ''}`)
}
console.log(`    100%を超えた月: ${over} / ${bm.size}`)

// 2. ブートストラップ
let seed = 20260819
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const v = sel.map((r) => r.y * r.odds)
const boot = []
for (let b = 0; b < 10000; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[(rnd() * v.length) | 0]; boot.push(s / v.length) }
boot.sort((a, b) => a - b)
const pc = (q) => boot[Math.floor(q * boot.length)]
console.log(`\n【2】ブートストラップ（1万回）`)
console.log(`    中央値 ${(pc(0.5) * 100).toFixed(1)}%   90%区間 [${(pc(0.05) * 100).toFixed(1)}%, ${(pc(0.95) * 100).toFixed(1)}%]`)
console.log(`    100%を下回った割合 ${((boot.filter((x) => x < 1).length / boot.length) * 100).toFixed(1)}%`)

// 3. 高配当の寄与
const hits = sel.filter((r) => r.y).sort((a, b) => b.odds - a.odds)
console.log(`\n【3】的中${hits.length}本の配当（大きい順に10本）`)
console.log(`    ${hits.slice(0, 10).map((r) => r.odds.toFixed(1) + '倍').join(' / ')}`)
const tot = sel.reduce((a, r) => a + r.y * r.odds, 0)
for (const k of [1, 3, 5, 10, 20]) {
  const cut = hits.slice(0, k).reduce((a, r) => a + r.odds, 0)
  console.log(`    上位${String(k).padStart(2)}本を除くと回収率 ${(((tot - cut) / sel.length) * 100).toFixed(1)}%`)
}

// 4. 閾値を動かす（滑らかか）
console.log(`\n【4】閾値を動かしたときの変化（滑らかなら本物、跳ねていれば偶然）`)
console.log('    下限     点数   的中率   回収率   前半     後半')
const months = [...new Set(rows.map((r) => r.month))].sort()
const half = Math.floor(months.length / 2)
const isE = (r) => months.indexOf(r.month) < half
for (const th of [1.5, 1.8, 2.0, 2.2, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0]) {
  const s = tops.filter((r) => r.odds >= th)
  if (s.length < 100) continue
  const t = st(s), e = st(s.filter(isE)), l = st(s.filter((r) => !isE(r)))
  console.log(`    ${th.toFixed(1)}倍  ${String(t.n).padStart(6)}   ${(t.hit * 100).toFixed(1).padStart(5)}%   ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(e ? (e.roi * 100).toFixed(1) : '-').padStart(6)}%  ${(l ? (l.roi * 100).toFixed(1) : '-').padStart(6)}%`)
}

// 5. 買い目の中身
console.log(`\n【5】買い目の中身（${MIN}倍以上）`)
const laneN = new Array(7).fill(0)
for (const r of sel) laneN[r.lane]++
console.log(`    枠別: ${laneN.slice(1).map((n, i) => `${i + 1}号艇 ${n}点(${((n / sel.length) * 100).toFixed(0)}%)`).join('  ')}`)
console.log(`    モデルの平均予想確率 ${(sel.reduce((a, r) => a + r.p, 0) / sel.length * 100).toFixed(1)}%  実際 ${(S.hit * 100).toFixed(1)}%`)
console.log(`    → モデルが強気すぎる場合、実際はもっと当たらない。差が小さいほど信頼できる`)
console.log(`    1レースあたりの購入率 ${((sel.length / byRace.size) * 100).toFixed(1)}%（何%のレースで買うか）`)
db.close()
