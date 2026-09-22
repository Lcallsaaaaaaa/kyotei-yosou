// 3連単を何点買うのが良いか。実オッズで並べ方を変えて比べる。
//   node --max-old-space-size=8192 scripts/pts3.mjs
//
// ★並べ方
//   ① 確率の高い順（従来）
//   ② 期待値の高い順（モデルの確率 × 実オッズ）※実オッズでは初めて試す
//   ③ 必要倍率を満たすものだけを確率順（余裕2.0）
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
const MO = new Map()
for (const r of db.prepare(`SELECT DISTINCT race_id, month FROM wi1`).iterate()) MO.set(r.race_id, r.month)
const P = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = P.get(r.race_id); if (!a) { a = new Map(); P.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length) {
      const p = P.get(cur), w = WIN.get(cur)
      if (p && w && w[1] && w[2] && w[3]) {
        const l = list.map((x) => ({ c: x.combo, o: x.odds, p: p.get(x.combo) ?? 0 })).filter((x) => x.p > 0)
        if (l.length > 100) races.push({ rid: cur, mo: MO.get(cur), truth: `${w[1]}-${w[2]}-${w[3]}`, l })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, odds FROM odds3t WHERE odds IS NOT NULL ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
const N = races.length
console.log(`${N.toLocaleString()}レース　3連単\n`)
const RANK = {
  '確率順': (l) => l.slice().sort((a, b) => b.p - a.p),
  '期待値順': (l) => l.slice().sort((a, b) => b.p * b.o - a.p * a.o),
  '余裕2.0内で確率順': (l) => l.filter((x) => x.o >= (1 / x.p) * 2).sort((a, b) => b.p - a.p),
  '余裕1.5内で期待値順': (l) => l.filter((x) => x.o >= (1 / x.p) * 1.5).sort((a, b) => b.p * b.o - a.p * a.o),
}
const sorted = new Map()
for (const [nm, f] of Object.entries(RANK)) sorted.set(nm, races.map((r) => ({ r, s: f(r.l) })))
console.log('  並べ方              点数  買うR  1R点数  的中率  平均払戻   回収率  1R損益  1日100円の損益')
for (const [nm, arr] of sorted) {
  for (const pts of [1, 2, 3, 5, 8, 12, 18, 24, 30]) {
    let nR = 0, bets = 0, hit = 0, ret = 0
    for (const { r, s } of arr) {
      const pick = s.slice(0, pts)
      if (!pick.length) continue
      nR++
      for (const x of pick) { bets++; if (x.c === r.truth) { hit++; ret += x.o * 100 } }
    }
    if (bets < 500) continue
    const roi = ret / (bets * 100) * 100
    const pl = (ret - bets * 100) / nR
    console.log(`  ${nm.padEnd(20)} ${String(pts).padStart(3)} ${String(nR).padStart(6)} ${(bets / nR).toFixed(1).padStart(6)} ${(hit / nR * 100).toFixed(2).padStart(7)}% ${(hit ? ret / hit : 0).toFixed(0).padStart(8)}円 ${roi.toFixed(2).padStart(8)}% ${pl.toFixed(0).padStart(7)}円 ${(pl * nR / 303).toFixed(0).padStart(13)}円`)
  }
  console.log('')
}
db.close()
