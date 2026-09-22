// 市場を混ぜると優位はどうなるか。
//
//   node --max-old-space-size=8192 scripts/blendtest.mjs
//
// ★問い
//   vsmarket.mjs で「モデル75%＋市場25%が最も正確（ブライア0.09665）」と出た。
//   ではそれを予想に使うべきか。
//
// ★仮説（本人の指摘）
//   使うべきでない。優位が出るのは**モデルと市場が食い違うところ**だけ。
//   混ぜれば市場に寄るので食い違いが縮み、儲けの源泉が消える。
//   市場はオッズ（払戻）としてだけ使い、予想はモデル単独でやる。
//
// ★測り方
//   混合率を変えて、①予測精度（ブライア）②食い違いの量 ③実際の回収率
//   の3つを並べる。①が良くなっても②③が悪くなるなら、混ぜてはいけない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor, MARGIN } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')

const M = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()) {
  let a = M.get(r.race_id); if (!a) { a = new Map(); M.set(r.race_id, a) }
  a.set(r.lane, { p: r.p, y: r.y })
}
const O = new Map()
for (const r of db.prepare(`SELECT race_id,lane,tansho FROM odds_tan WHERE tansho>0`).all()) {
  let a = O.get(r.race_id); if (!a) { a = new Map(); O.set(r.race_id, a) }
  a.set(r.lane, r.tansho)
}
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id,combo,amount FROM payouts WHERE bet_type='tansho' AND amount>0`).all())
  PAY.set(r.race_id + '|' + r.combo, r.amount / 100)
const DL = new Map()
for (const r of db.prepare(`SELECT race_id,date,deadline FROM races WHERE deadline IS NOT NULL`).all()) {
  const [h, m] = r.deadline.split(':').map(Number)
  if (Number.isFinite(h)) DL.set(r.race_id, { date: r.date, dl: h * 60 + m })
}

// レース単位に整える
const races = []
for (const [rid, m] of M) {
  const o = O.get(rid), d = DL.get(rid)
  if (!o || o.size !== 6 || m.size !== 6 || !d) continue
  const sum = [...o.values()].reduce((a, x) => a + 1 / x, 0)
  if (sum < 1.15 || sum > 1.60) continue
  const lanes = []
  for (const [lane, v] of m)
    lanes.push({ lane, p: v.p, q: (1 / o.get(lane)) / sum, odds: o.get(lane), y: v.y,
      pay: PAY.get(rid + '|' + lane) ?? 0 })
  races.push({ rid, date: d.date, dl: d.dl, lanes })
}
console.log(`対象 ${races.length.toLocaleString()}レース\n`)

console.log('混合率        ブライア    本命が市場と  食い違い時の   買い目   的中     回収率')
console.log('（モデル:市場）            食い違う率    モデル的中率   点数')
for (const w of [1.0, 0.9, 0.75, 0.5, 0.25, 0.0]) {
  const mix = (x) => w * x.p + (1 - w) * x.q
  // ① 予測精度
  let br = 0, n = 0
  for (const r of races) for (const x of r.lanes) { br += (mix(x) - x.y) ** 2; n++ }
  br /= n
  // ② 食い違い
  let diff = 0, mHit = 0
  for (const r of races) {
    const mf = r.lanes.reduce((a, b) => (mix(b) > mix(a) ? b : a))
    const qf = r.lanes.reduce((a, b) => (b.q > a.q ? b : a))
    if (mf.lane !== qf.lane) { diff++; if (mf.y) mHit++ }
  }
  // ③ 実際の回収率（必要倍率＝1÷混合確率×余裕・確定オッズで足切り・締切順・1日3本）
  const byDay = new Map()
  for (const r of races) {
    const f = r.lanes.reduce((a, b) => (mix(b) > mix(a) ? b : a))
    const need = minOddsFor(mix(f), MARGIN)
    if (f.odds < need) continue
    let a = byDay.get(r.date); if (!a) { a = []; byDay.set(r.date, a) }
    a.push({ dl: r.dl, pay: f.pay })
  }
  const S = []
  for (const [, v] of byDay) S.push(...v.sort((a, b) => a.dl - b.dl).slice(0, 3))
  const hit = S.filter((x) => x.pay > 0).length
  const roi = S.length ? S.reduce((a, x) => a + x.pay, 0) / S.length : 0
  console.log(`${(w * 100).toFixed(0).padStart(3)}:${((1 - w) * 100).toFixed(0).padEnd(3)}     ${br.toFixed(5)}  ${(diff / races.length * 100).toFixed(1).padStart(10)}% ${(diff ? mHit / diff * 100 : 0).toFixed(1).padStart(13)}% ${String(S.length).padStart(8)} ${(S.length ? hit / S.length * 100 : 0).toFixed(1).padStart(7)}% ${(roi * 100).toFixed(1).padStart(8)}%`)
}
console.log('\n※ 回収率は確定オッズで足切りした場合。買う時点では実行できないが、')
console.log('  混合率どうしの比較には使える（全部同じ条件で不利になっているため）。')
db.close()
