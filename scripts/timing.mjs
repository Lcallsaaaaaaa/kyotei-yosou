// 「締切ギリギリまで待てば、確定オッズに近づいて条件が当たるのか」を測る。
//
//   node scripts/timing.mjs
//
// ★問い
//   確定オッズで足切りすると単勝192.7%。締切2〜3分前のオッズだと73.0%。
//   では **もっと遅く**、締切直前に人間が見て買えば近づくのか。
//
// ★測り方
//   odds_live は締切20分前から締切まで記録している。
//   分前ごとに「そのとき見えたオッズで条件を満たした本命」を取り出し、
//   ① 確定でも条件を満たしていたか（＝検証と同じ舟券だったか）
//   ② 実払戻で回収率はいくらか
//   を出す。①が分前とともに上がるなら「待てば直る」。
//
// ★注意：記録は取得時刻ベース
//   スクレイパが1件ずつ巡回しているので、表示の遅れが含まれる。
//   人間が締切30秒前に画面を見た場合より不利な条件になっている可能性はある。
//   そこは断定しない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor, MARGIN, FUKU } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

for (const [t, col, sumLo, sumHi, mg, lab] of [
  ['tansho', 'tansho', 1.15, 1.60, MARGIN, '単勝'],
  ['fukusho', 'fukusho_lo', FUKU.sumLo, FUKU.sumHi, FUKU.margin, '複勝'],
]) {
  // モデルの本命（買う時点で分かる）
  const FAV = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,p,odds,pay FROM bt WHERE bet_type=?`).all(t))
    FAV.set(r.race_id, r)

  // 分前ごとの読み（プール形成の検算つき）
  const byMin = new Map()   // mins_before -> [{rid, pre, fav}]
  const raw = new Map()     // rid -> mins -> Map(lane->odds)
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE ${col} > 0 AND mins_before BETWEEN 0 AND 20`).all()) {
    let m = raw.get(r.race_id); if (!m) { m = new Map(); raw.set(r.race_id, m) }
    let o = m.get(r.mins_before); if (!o) { o = new Map(); m.set(r.mins_before, o) }
    o.set(r.lane, r.v)
  }
  for (const [rid, m] of raw) {
    const fav = FAV.get(rid); if (!fav) continue
    for (const [mins, o] of m) {
      if (o.size < 4) continue
      const s = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (s < sumLo || s > sumHi) continue
      const pre = o.get(fav.lane); if (pre == null) continue
      let a = byMin.get(mins); if (!a) { a = []; byMin.set(mins, a) }
      a.push({ rid, pre, fav })
    }
  }

  console.log(`\n══════ ${lab}　必要倍率=(1÷確率)×${mg} ══════`)
  console.log(' 分前   読み数  条件を満たす  うち確定でも満たす   実払戻での回収率')
  const BK = [[0, 0], [1, 1], [2, 3], [4, 6], [7, 9], [10, 12], [13, 16], [17, 20]]
  for (const [lo, hi] of BK) {
    const s = []
    for (const [mins, a] of byMin) if (mins >= lo && mins <= hi) s.push(...a)
    if (s.length < 60) continue
    const pass = s.filter((x) => x.pre >= minOddsFor(x.fav.p, mg))
    if (!pass.length) { console.log(`${String(lo).padStart(3)}〜${String(hi).padStart(2)} ${String(s.length).padStart(7)}        0本`); continue }
    const both = pass.filter((x) => x.fav.odds >= minOddsFor(x.fav.p, mg))
    const roi = pass.reduce((a, x) => a + x.fav.pay, 0) / pass.length
    console.log(`${String(lo).padStart(3)}〜${String(hi).padStart(2)} ${String(s.length).padStart(7)} ${String(pass.length).padStart(9)}本 ${String(both.length).padStart(11)}本 (${(both.length / pass.length * 100).toFixed(0)}%) ${(roi * 100).toFixed(1).padStart(12)}%`)
  }

  // 参考：そのレース群を確定オッズで足切りしたら
  const all = new Set()
  for (const [, a] of byMin) for (const x of a) all.add(x.rid)
  const A = [...all].map((rid) => FAV.get(rid)).filter(Boolean)
    .filter((x) => x.odds >= minOddsFor(x.p, mg))
  if (A.length)
    console.log(`  （同じ${all.size}レースを確定オッズで足切り＝実行不能：${A.length}本 回収${(A.reduce((a, x) => a + x.pay, 0) / A.length * 100).toFixed(1)}%）`)
}
db.close()
