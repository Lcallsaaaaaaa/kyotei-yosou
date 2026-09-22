// 予想が実際に儲かるのかを、3連単のオッズで検証する。
//
//   node scripts/roi.mjs
//
// ★ここが本番
//   これまで測ってきたのは「当たるか」だけ。的中率57%でも、
//   人気どおりに当てているだけなら回収率は100%を割る。控除率が25%あるので、
//   **人気と同じ予想をした時点で必ず負ける**。勝てるのは、オッズが実力を
//   取り違えている組み合わせを見つけた時だけ。
//
// ★1着の確率から3連単120通りを出す方法
//   Plackett-Luce。1着がa、次にbが残り5艇の中で1位、次にcが残り4艇の中で1位。
//     P(a-b-c) = p_a × p_b/(1-p_a) × p_c/(1-p_a-p_b)
//   モデルのpは6艇で合計1になっているので、そのまま強さとして使える。
//   ※ 以前、各艇の1着率をそのまま足して合計1.38になる指標を確率扱いした失敗をした。
//     今回のpは6艇の比較から出しているので、その問題は起きない。
//
// ★このバックテストの限界（結果を読むときに必ず考慮すること）
//   1. 使っているのは締切後の確定オッズ。実際に買うのは締切前で、その時のオッズは違う。
//   2. 自分が買った分でオッズが下がることを考慮していない。少額なら影響は小さい。
//   → つまりここで出る回収率は**実際より良く出る**。100%を少し超えた程度では勝てない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)

// ---------- まずオッズが正しいか確かめる ----------
// 的中した組のオッズ×100が、実際の払戻金と一致するはず。
console.log('=== オッズの検算（的中組のオッズ×100 = 払戻金 か） ===')
const chk = all(`
  SELECT o.race_id, o.odds, p.amount
  FROM payouts p
  JOIN odds3t o ON o.race_id = p.race_id AND o.combo = p.combo
  WHERE p.bet_type = 'sanrentan' AND o.odds IS NOT NULL AND p.amount IS NOT NULL
  LIMIT 20000`)
let okN = 0
for (const r of chk) if (Math.abs(r.odds * 100 - r.amount) <= Math.max(100, r.amount * 0.02)) okN++
console.log(`  ${okN} / ${chk.length} 一致 (${((okN / chk.length) * 100).toFixed(1)}%)`)
if (okN / chk.length < 0.9) { console.log('  ⚠️ 一致率が低い。オッズの読み取りに誤りがある可能性がある'); }

// ---------- 検証期間のデータを組む ----------
const rows = all(`SELECT race_id, lane, p, y FROM pred WHERE split='test' ORDER BY race_id, lane`)
const races = new Map()
for (const r of rows) {
  let g = races.get(r.race_id); if (!g) { g = []; races.set(r.race_id, g) }
  g.push(r)
}
console.log(`\n検証期間 ${races.size.toLocaleString()} レース`)

const odds = new Map()
for (const r of all(`SELECT o.race_id, o.combo, o.odds FROM odds3t o
  JOIN pred p ON p.race_id = o.race_id AND p.split='test' AND p.lane=1`)) {
  let m = odds.get(r.race_id); if (!m) { m = new Map(); odds.set(r.race_id, m) }
  m.set(r.combo, r.odds)
}
const win = new Map()
for (const r of all(`SELECT p.race_id, p.combo FROM payouts p
  JOIN pred q ON q.race_id = p.race_id AND q.split='test' AND q.lane=1
  WHERE p.bet_type='sanrentan'`)) win.set(r.race_id, r.combo)

// ---------- 3連単120通りの確率を出す ----------
function combos(boats) {
  const p = new Array(7).fill(0)
  for (const b of boats) p[b.lane] = b.p
  const out = []
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) { if (b === a) continue
    for (let c = 1; c <= 6; c++) { if (c === a || c === b) continue
      const r1 = 1 - p[a], r2 = 1 - p[a] - p[b]
      if (r1 <= 1e-9 || r2 <= 1e-9) continue
      out.push({ combo: `${a}-${b}-${c}`, prob: p[a] * (p[b] / r1) * (p[c] / r2) })
    } }
  return out
}

// ---------- 戦略ごとに回収率を測る ----------
const strategies = []
// (1) 確率が高い順にN点買う
for (const n of [1, 2, 3, 5, 10, 20]) strategies.push({ name: `確率上位${n}点`, pick: (c) => c.slice(0, n) })
// (2) 期待値（確率×オッズ）が閾値を超えたものを買う
for (const th of [1.0, 1.1, 1.2, 1.3, 1.5, 2.0]) strategies.push({ name: `期待値${th.toFixed(1)}以上`, pick: (c) => c.filter((x) => x.ev >= th) })
// (3) 期待値が閾値を超え、かつ確率も一定以上（少確率の万舟狙いを除く）
for (const th of [1.1, 1.2, 1.3]) for (const pm of [0.01, 0.02, 0.05])
  strategies.push({ name: `期待値${th.toFixed(1)}以上 かつ確率${(pm * 100).toFixed(0)}%以上`, pick: (c) => c.filter((x) => x.ev >= th && x.prob >= pm) })

const res = strategies.map((s) => ({ ...s, bet: 0, back: 0, hit: 0, races: 0 }))
let used = 0
for (const [rid, boats] of races) {
  const om = odds.get(rid); if (!om) continue
  const w = win.get(rid)
  const cs = combos(boats)
  for (const c of cs) { c.odds = om.get(c.combo) ?? null; c.ev = c.odds ? c.prob * c.odds : 0 }
  const valid = cs.filter((c) => c.odds != null)
  if (valid.length < 100) continue
  used++
  const byProb = [...valid].sort((a, b) => b.prob - a.prob)
  for (const s of res) {
    const src = s.name.startsWith('確率上位') ? byProb : valid
    const picks = s.pick(src)
    if (!picks.length) continue
    s.races++
    for (const c of picks) {
      s.bet += 100
      if (c.combo === w) { s.back += c.odds * 100; s.hit++ }
    }
  }
}
console.log(`オッズが揃っている ${used.toLocaleString()} レースで検証\n`)

console.log('=== 3連単の回収率（検証期間・確定オッズ使用） ===')
console.log('  戦略                              買ったレース  点数     的中   的中率   回収率')
res.sort((a, b) => (b.bet ? b.back / b.bet : 0) - (a.bet ? a.back / a.bet : 0))
for (const s of res) {
  if (!s.bet) { console.log(`  ${s.name.padEnd(32)} 該当なし`); continue }
  const roi = (s.back / s.bet) * 100
  const pts = s.bet / 100
  const hr = (s.hit / pts) * 100
  console.log(`  ${s.name.padEnd(32)} ${String(s.races).padStart(8)} ${String(pts).padStart(8)} ${String(s.hit).padStart(6)}  ${hr.toFixed(2).padStart(6)}%  ${roi.toFixed(1).padStart(6)}%`)
}
console.log('\n※ 締切後の確定オッズを使っているので、実際の回収率はこれより低くなる。')
console.log('※ 控除率25%＝何も考えずに買えば回収率75%。100%を超えて初めて意味がある。')
db.close()
