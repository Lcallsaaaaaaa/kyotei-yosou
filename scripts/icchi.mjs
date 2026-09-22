// 3連単を「モデルと市場の意見が一致しているか」で判定する。
//   node --max-old-space-size=8192 scripts/icchi.mjs
//
// ★なぜこの発想が筋か
//   3連単は市場のほうが正確（1着を当てる精度 市場58.21% 対 モデル57.35%）。
//   単勝は逆（モデル57.35% 対 市場55.24%）なので、
//   単勝は「食い違い」を狙い、3連単は「一致」を狙う、という切り分けになる。
//
// ★一致の測り方を4通り試す
//   A 本命が同じか（モデルの1番人気＝市場の1番人気）
//   B 上位3点の重なり
//   C モデル確率 ÷ 市場確率 が1に近いか
//   D 市場の本命を買う（モデルは絞りにだけ使う）
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
const MP = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = MP.get(r.race_id); if (!a) { a = new Map(); MP.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length === 120) {
      const w = WIN.get(cur), mp = MP.get(cur)
      if (w && w[1] && w[2] && w[3] && mp) {
        let s = 0
        for (const x of list) s += 1 / x.odds
        const q = new Map()
        for (const x of list) q.set(x.combo, (1 / x.odds) / s)
        const mSort = [...mp].sort((a, b) => b[1] - a[1])
        const qSort = [...q].sort((a, b) => b[1] - a[1])
        const od = new Map(list.map((x) => [x.combo, x.odds]))
        races.push({ rid: cur, mo: MO.get(cur), truth: `${w[1]}-${w[2]}-${w[3]}`,
          m: mSort, q: qSort, od, mp, qp: q })
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
const MOS = [...new Set(races.map((r) => r.mo))].filter(Boolean).sort()
console.log(`${N.toLocaleString()}レース\n`)
const ev = (arr, pickFn, pts) => {
  let bets = 0, hit = 0, ret = 0
  const per = new Map()
  for (const r of arr) {
    for (const c of pickFn(r).slice(0, pts)) {
      bets++
      let a = per.get(r.mo); if (!a) { a = { b: 0, r: 0 }; per.set(r.mo, a) }
      a.b++
      if (c === r.truth) { hit++; const o = r.od.get(c) ?? 0; ret += o * 100; a.r += o * 100 }
    }
  }
  if (bets < 300) return null
  const ms = [...per.values()].filter((a) => a.b >= 50)
  return { n: arr.length, bets, hr: hit / arr.length * 100, roi: ret / (bets * 100) * 100,
    avg: hit ? ret / hit : 0, plus: ms.filter((a) => a.r / (a.b * 100) >= 1).length, months: ms.length }
}
const show = (lab, x) => { if (x) console.log(`  ${lab.padEnd(34)} ${String(x.n).padStart(6)}R ${String(x.bets).padStart(6)}点 的中${x.hr.toFixed(2).padStart(6)}% 平均${x.avg.toFixed(0).padStart(6)}円 回収${x.roi.toFixed(2).padStart(7)}% ${x.plus}/${x.months}ヶ月`) }

const mTop = (r) => r.m.map((x) => x[0])
const qTop = (r) => r.q.map((x) => x[0])
console.log('■ 基準（絞らない）')
for (const pts of [1, 3, 6]) show(`モデルの確率順 ${pts}点`, ev(races, mTop, pts))
for (const pts of [1, 3, 6]) show(`市場の人気順 ${pts}点`, ev(races, qTop, pts))

console.log('\n■ A 本命が一致しているレースだけ')
{
  const same = races.filter((r) => r.m[0][0] === r.q[0][0])
  const diff = races.filter((r) => r.m[0][0] !== r.q[0][0])
  console.log(`  一致 ${same.length.toLocaleString()}レース（${(same.length / N * 100).toFixed(1)}%）／不一致 ${diff.length.toLocaleString()}`)
  for (const pts of [1, 3, 6]) show(`一致・モデル順 ${pts}点`, ev(same, mTop, pts))
  for (const pts of [1, 3]) show(`不一致・モデル順 ${pts}点`, ev(diff, mTop, pts))
}
console.log('\n■ B 上位3点の重なりの数で絞る')
for (const k of [0, 1, 2, 3]) {
  const s = races.filter((r) => {
    const a = new Set(r.m.slice(0, 3).map((x) => x[0]))
    return r.q.slice(0, 3).filter((x) => a.has(x[0])).length === k
  })
  if (s.length < 500) continue
  show(`重なり${k}点・モデル順3点`, ev(s, mTop, 3))
}
console.log('\n■ C モデル確率 ÷ 市場確率（本命）が1に近いレース')
for (const [lo, hi] of [[0, 0.7], [0.7, 0.9], [0.9, 1.15], [1.15, 1.5], [1.5, 99]]) {
  const s = races.filter((r) => { const c = r.m[0][0]; const q = r.qp.get(c) ?? 0; return q > 0 && r.m[0][1] / q >= lo && r.m[0][1] / q < hi })
  if (s.length < 500) continue
  show(`比 ${lo}〜${hi}・モデル順3点`, ev(s, mTop, 3))
}
console.log('\n■ D 一致レースで市場の本命を買う')
{
  const same = races.filter((r) => r.m[0][0] === r.q[0][0])
  for (const pts of [1, 3, 6]) show(`一致・市場順 ${pts}点`, ev(same, qTop, pts))
}
db.close()
