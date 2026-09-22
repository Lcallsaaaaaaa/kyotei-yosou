// 配信用の絞りを「本番モデル(pred3)」で測る。
//   node --max-old-space-size=8192 scripts/haishin-check3.mjs
//
// ★なぜ測り直すか
//   最初は歩進検証(wi3)で測った。だが実際に朝走るのは predict.mjs → model5.json で、
//   pred3 がその出力にあたる。同じ22,614レースで自信度の分布が違った：
//     pred3 中央値0.6135（0.8282以上は2.8%）／ wi3 中央値0.6705（同9.5%）
//   1着的中も対数尤度も同じなのに確率の鋭さだけ違う。閾値は本番側で決めないと合わない。
//
// ★学習に使った期間は外す
//   model5.json は 2026-03-25 まで学習している。それ以前は「答えを見たあと」なので使わない。
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
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
    WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
// 学習後のレースだけ（split が calib / test のもの）
const OK = new Map()
for (const r of db.prepare(`SELECT DISTINCT race_id, date, split FROM pred WHERE split IN ('calib','test')`).iterate())
  OK.set(r.race_id, r.date.slice(0, 7))
console.log(`学習後のレース ${OK.size.toLocaleString()}（split=calib/test）`)

const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120 && OK.has(cur)) {
      const w = WIN.get(cur)
      if (w && w[1] && w[2] && w[3]) {
        const m = list.slice().sort((a, b) => b.p - a.p).map((x) => [x.combo, x.p])
        const fk = new Map()
        for (const [c, p] of m) { const k = c.split('-').sort().join('-'); fk.set(k, (fk.get(k) ?? 0) + p) }
        const f = [...fk].sort((a, b) => b[1] - a[1])
        races.push({ rid: cur, mo: OK.get(cur), m, f,
          t3: `${w[1]}-${w[2]}-${w[3]}`, tf: [w[1], w[2], w[3]].sort().join('-'),
          conf: f.slice(0, 4).reduce((a, b) => a + b[1], 0) })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, p FROM pred3 ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
const DAYS = new Set([...races.map((r) => r.rid.slice(0, 8))]).size
console.log(`使うレース ${races.length.toLocaleString()}（${DAYS}日）\n`)
function ev(arr, kind, pts) {
  const src = kind === 'sanrentan' ? 'm' : 'f', truth = kind === 'sanrentan' ? 't3' : 'tf'
  let bets = 0, hit = 0, ret = 0
  const per = new Map()
  for (const r of arr) {
    let h = 0, g = 0
    for (const [c] of r[src].slice(0, pts)) {
      bets++
      if (c === r[truth]) { const p = PAY.get(r.rid + '|' + kind + '|' + c); if (p == null) continue; h = 1; g += p }
    }
    hit += h; ret += g
    let a = per.get(r.mo); if (!a) { a = { n: 0, h: 0 }; per.set(r.mo, a) }
    a.n++; a.h += h
  }
  const ms = [...per].sort().map(([, a]) => a.h / a.n * 100)
  return { n: arr.length, hit: hit / arr.length * 100, roi: ret / (bets * 100) * 100,
    lo: Math.min(...ms), hi: Math.max(...ms) }
}
const sorted = races.slice().sort((a, b) => b.conf - a.conf)
const th = (p) => sorted[Math.max(0, Math.round(races.length * p / 100) - 1)].conf
console.log('自信度の区切り（本番モデル）')
for (const p of [50, 25, 15, 10, 5, 3]) console.log(`  上位${String(p).padStart(2)}% → conf >= ${th(p).toFixed(4)}`)
console.log('')
for (const [kind, nm] of [['sanrenpuku', '3連複'], ['sanrentan', '3連単']]) {
  console.log(`【${nm} 4点】`)
  console.log('  絞り      レース数  1日あたり   的中率   回収率   月ごとの的中')
  for (const p of [100, 50, 25, 15, 10, 5, 3]) {
    const e = ev(sorted.slice(0, Math.round(races.length * p / 100)), kind, 4)
    console.log(`  上位${String(p).padStart(3)}% ${String(e.n).padStart(9)} ${(e.n / DAYS).toFixed(1).padStart(8)}本 ${e.hit.toFixed(2).padStart(8)}% ${e.roi.toFixed(1).padStart(7)}% ${e.lo.toFixed(1)}〜${e.hi.toFixed(1)}%`)
  }
  console.log('')
}
console.log('【点数を変える／絞りは上位10%】')
console.log('  券種   点数   的中率   回収率')
for (const [kind, nm] of [['sanrenpuku', '3連複'], ['sanrentan', '3連単']]) {
  const arr = sorted.slice(0, Math.round(races.length * 0.10))
  for (const pts of [3, 4, 5, 6]) {
    const e = ev(arr, kind, pts)
    console.log(`  ${nm} ${String(pts).padStart(4)}点 ${e.hit.toFixed(2).padStart(8)}% ${e.roi.toFixed(1).padStart(7)}%`)
  }
}
db.close()
