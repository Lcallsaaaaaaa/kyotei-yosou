// 配当が中央値あたりのレースを、事前に狙えるか。
//   node --max-old-space-size=6144 scripts/chuo.mjs
//
// ★問い
//   配当は「市場がその目をどれだけ買ったか」で決まる。つまり配当＝オッズ。
//   締切前にオッズが見られるなら配当は事前に分かる。問題は
//   「その帯を狙って、なお当たるのか」。
//   モデルの確率で選ぶと配当の低い帯に寄ってしまう（当たり平均116円）。
//   配当の帯ごとに、モデルがどれだけ当てられるかを測る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  O.set(r.race_id + '|' + r.lane, r.tansho)
const KM = new Map()
for (const r of db.prepare(`SELECT race_id, kimarite FROM races WHERE date>='2025-10-01'`).all()) KM.set(r.race_id, r.kimarite)
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM wi1 ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const od = O.get(rid + '|' + bs[0].lane)
  if (!(od > 0)) continue
  rs.push({ rid, p: bs[0].p, lane: bs[0].lane, hit: bs[0].y === 1, od, km: KM.get(rid), mo: bs[0].month })
}
const N = rs.length
console.log(`${N.toLocaleString()}レース　モデルの本命の単勝\n`)

console.log('① 買う前に分かるオッズの帯ごと（オッズは締切前に見られる＝事前に選べる）')
console.log('  オッズ帯       レース数   1日    的中率  平均払戻   回収率  1レース損益  モデル確率の平均')
const B = [1.2, 1.4, 1.6, 2.0, 2.5, 3.5, 5, 10, 1e9]
let prev = 1
for (const b of B) {
  const s = rs.filter((r) => r.od > prev && r.od <= b)
  if (s.length < 300) { prev = b; continue }
  const h = s.filter((r) => r.hit)
  const ret = h.reduce((a, r) => a + r.od * 100, 0)
  const lab = b > 1e8 ? `${prev}倍超` : `${prev}〜${b}倍`
  console.log(`  ${lab.padEnd(12)} ${String(s.length).padStart(8)} ${(s.length / 303).toFixed(1).padStart(6)}本 ${(h.length / s.length * 100).toFixed(2).padStart(7)}% ${(h.length ? ret / h.length : 0).toFixed(0).padStart(7)}円 ${(ret / (s.length * 100) * 100).toFixed(2).padStart(8)}% ${((ret - s.length * 100) / s.length).toFixed(0).padStart(10)}円 ${(s.reduce((a, r) => a + r.p, 0) / s.length).toFixed(3).padStart(12)}`)
  prev = b
}

console.log('\n② モデルの確率 × オッズ帯（両方で絞る）')
console.log('  確率        オッズ      レース数   1日    的中率   回収率  1レース損益')
for (const [lo, hi] of [[0.5, 1.01], [0.6, 1.01], [0.7, 1.01]]) {
  for (const [a, b] of [[1, 1.4], [1.4, 1.8], [1.8, 2.5], [2.5, 4], [4, 1e9]]) {
    const s = rs.filter((r) => r.p >= lo && r.p < hi && r.od > a && r.od <= b)
    if (s.length < 200) continue
    const h = s.filter((r) => r.hit)
    const ret = h.reduce((x, r) => x + r.od * 100, 0)
    const lab = b > 1e8 ? `${a}倍超` : `${a}〜${b}倍`
    console.log(`  ${lo.toFixed(2)}以上  ${lab.padEnd(10)} ${String(s.length).padStart(8)} ${(s.length / 303).toFixed(1).padStart(6)}本 ${(h.length / s.length * 100).toFixed(2).padStart(7)}% ${(ret / (s.length * 100) * 100).toFixed(2).padStart(8)}% ${((ret - s.length * 100) / s.length).toFixed(0).padStart(10)}円`)
  }
  console.log('')
}
console.log('③ 100円を超えた回収があった帯だけ抜き出す（月ごとの安定も見る）')
const cand = []
for (const [lo, hi] of [[0.4, 0.6], [0.5, 0.7], [0.6, 0.8], [0.7, 1.01], [0.3, 0.5]]) {
  for (const [a, b] of [[1, 1.3], [1.3, 1.6], [1.6, 2.0], [2.0, 2.5], [2.5, 3.5], [3.5, 6], [6, 1e9]]) {
    const s = rs.filter((r) => r.p >= lo && r.p < hi && r.od > a && r.od <= b)
    if (s.length < 400) continue
    const h = s.filter((r) => r.hit)
    const ret = h.reduce((x, r) => x + r.od * 100, 0)
    const roi = ret / (s.length * 100) * 100
    cand.push({ lo, hi, a, b, n: s.length, hr: h.length / s.length * 100, roi, s })
  }
}
cand.sort((x, y) => y.roi - x.roi)
for (const c of cand.slice(0, 6)) {
  const lab = `確率${c.lo}〜${c.hi} オッズ${c.a}〜${c.b > 1e8 ? '上' : c.b}倍`
  console.log(`  ${lab.padEnd(30)} ${String(c.n).padStart(6)}本 的中${c.hr.toFixed(2)}% 回収${c.roi.toFixed(2)}%`)
  const per = [...new Set(rs.map((r) => r.mo))].sort().map((mo) => {
    const t = c.s.filter((r) => r.mo === mo)
    if (t.length < 20) return `${mo.slice(5)}:-`
    const h = t.filter((r) => r.hit)
    return `${mo.slice(5)}:${(h.reduce((x, r) => x + r.od * 100, 0) / (t.length * 100) * 100).toFixed(0)}%`
  })
  console.log(`     月ごと ${per.join(' ')}`)
}
db.close()
