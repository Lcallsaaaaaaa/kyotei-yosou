// モデルが選んだ艇の単勝を買い続けたときの回収率。
//   node --max-old-space-size=5120 scripts/roi-model.mjs --t wi1
//
// ★これは実運用できる形の検証
//   選ぶのは**モデルの確率だけ**。オッズは一切見ない。
//   払い戻しは確定オッズ（＝実際に受け取る額）。
//   以前やって怒られたのは「確定オッズでレースを絞った」ケース。今回は絞りに使っていない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wi1')

const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  O.set(r.race_id + '|' + r.lane, r.tansho)
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const rs = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const od = O.get(rid + '|' + bs[0].lane)
  if (!(od > 0)) continue
  rs.push({ p: bs[0].p, lane: bs[0].lane, hit: bs[0].y === 1 ? 1 : 0, od, mo: bs[0].month })
}
const N = rs.length
console.log(`${N.toLocaleString()}レース　モデルの本命の単勝を買い続ける\n`)
const show = (s, lab) => {
  if (!s.length) return
  const hit = s.reduce((a, r) => a + r.hit, 0)
  const ret = s.reduce((a, r) => a + (r.hit ? r.od * 100 : 0), 0)
  const roi = ret / (s.length * 100) * 100
  console.log(`  ${lab.padEnd(18)} ${String(s.length).padStart(8)}本 ${(s.length / 303).toFixed(1).padStart(6)}本/日 平均${(s.reduce((a, r) => a + r.od, 0) / s.length).toFixed(2).padStart(5)}倍 的中${(hit / s.length * 100).toFixed(2).padStart(6)}% 回収${roi.toFixed(2).padStart(7)}%`)
}
show(rs, '全部買う')
console.log('')
console.log('モデルの確率で絞る（オッズは見ない）')
for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.757], [0.757, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 1.01]])
  show(rs.filter((r) => r.p >= lo && r.p < hi), `確率 ${lo}〜${hi}`)
console.log('')
console.log('しきい値以上をまとめて買う')
for (const th of [0.5, 0.6, 0.65, 0.7, 0.757, 0.8, 0.85])
  show(rs.filter((r) => r.p >= th), `確率 ${th} 以上`)
console.log('')
console.log('本命が1号艇のときだけ')
for (const th of [0, 0.6, 0.7, 0.757, 0.8])
  show(rs.filter((r) => r.lane === 1 && r.p >= th), `1号艇 かつ ${th}以上`)
console.log('')
console.log('本命が1号艇以外のときだけ')
for (const th of [0, 0.5, 0.6])
  show(rs.filter((r) => r.lane !== 1 && r.p >= th), `1号艇以外 ${th}以上`)
// 月ごと（安定しているか）
const best = rs.filter((r) => r.p >= 0.6)
console.log('\n確率0.6以上を月ごとに')
for (const mo of [...new Set(rs.map((r) => r.mo))].sort()) show(best.filter((r) => r.mo === mo), mo)
db.close()
