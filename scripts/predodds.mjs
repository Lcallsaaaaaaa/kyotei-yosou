// 締切前オッズから確定オッズを予測できるか検証する。
//
//   node scripts/predodds.mjs
//
// ★なぜ要るか
//   gapcheck.mjs で分かったこと：締切前オッズで足切りすると、検証が買う集合と
//   **重なりゼロ**の別物を買う。締切前に高く見える艇は締切間際に買われて潰れるため。
//   足切りを「見えているオッズ」でなく「確定オッズの予測値」に変えられれば直る。
//
// ★2つの方法を比べる
//   (A) 帯別の縮み率　predicted = pre × 中央値(確定÷締切前)
//       単純。ただし帯ごとに一律なので、同じ帯なら全部同じ倍率で縮める。
//   (B) プール補正　　predicted = 1 ÷ (締切前のシェア × 確定Σ)
//       締切前はプールが未完成でΣ(1/オッズ)が小さい。各艇の「シェア」は
//       そのままに、プールが確定サイズまで埋まったと仮定して引き直す。
//       物理的な理由がある補正なので、こちらが効くはず。
//
// ★評価は「当てられたか」ではなく「足切りに使えるか」
//   予測の誤差が小さくても、閾値をまたぐ判定が当たらなければ意味がない。
//   2026-08-23にその取り違えをした。両方出す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor, MARGIN, FUKU, CHECK_FROM, CHECK_UNTIL } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const q = (a, x) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * x))] : NaN

// 締切前オッズを「レース単位」で取り出す（シェア計算に全艇必要）
function liveRaces(col, sumLo, sumHi) {
  const byRace = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE mins_before BETWEEN ? AND ? AND ${col} > 0`).all(CHECK_UNTIL, CHECK_FROM)) {
    let m = byRace.get(r.race_id); if (!m) { m = new Map(); byRace.set(r.race_id, m) }
    let o = m.get(r.mins_before); if (!o) { o = new Map(); m.set(r.mins_before, o) }
    o.set(r.lane, r.v)
  }
  const out = new Map()
  for (const [rid, byMin] of byRace)
    for (const mins of [...byMin.keys()].sort((a, b) => b - a)) {
      const o = byMin.get(mins)
      if (o.size < 4) continue
      const s = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (s < sumLo || s > sumHi) continue
      out.set(rid, { odds: o, sum: s, mins }); break
    }
  return out
}

for (const [t, col, sumLo, sumHi, mg, lab] of [
  ['tansho', 'tansho', 1.15, 1.60, MARGIN, '単勝'],
  ['fukusho', 'fukusho_lo', FUKU.sumLo, FUKU.sumHi, FUKU.margin, '複勝'],
]) {
  const L = liveRaces(col, sumLo, sumHi)
  // 確定オッズ（全艇）
  const FIN = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,${col} v FROM odds_tan WHERE ${col} > 0`).all()) {
    let m = FIN.get(r.race_id); if (!m) { m = new Map(); FIN.set(r.race_id, m) }
    m.set(r.lane, r.v)
  }
  // 全艇ペア（予測式を作るため）
  const pairs = []
  for (const [rid, v] of L) {
    const f = FIN.get(rid); if (!f) continue
    const fsum = [...f.values()].reduce((a, n) => a + 1 / n, 0)
    for (const [lane, pre] of v.odds) {
      const fin = f.get(lane)
      if (fin == null || fin <= 0) continue
      pairs.push({ rid, lane, pre, fin, share: (1 / pre) / v.sum, fsum })
    }
  }
  if (pairs.length < 200) { console.log(`\n${lab}：ペアが${pairs.length}件しかない。検証不能`); continue }

  const FSUM = (() => { const a = [...new Set(pairs.map((p) => p.rid))]
    .map((rid) => pairs.find((p) => p.rid === rid).fsum).sort((x, y) => x - y); return q(a, .5) })()

  // (A) 帯別の縮み率
  const BANDS = [[0, 1.5], [1.5, 2.5], [2.5, 4], [4, 7], [7, 12], [12, 25], [25, 1e9]]
  const ratio = BANDS.map(([lo, hi]) => {
    const a = pairs.filter((p) => p.pre >= lo && p.pre < hi).map((p) => p.fin / p.pre).sort((x, y) => x - y)
    return { n: a.length, r: a.length >= 20 ? q(a, .5) : 1 }
  })
  const predA = (pre) => pre * ratio[BANDS.findIndex(([lo, hi]) => pre >= lo && pre < hi)].r
  // (B) プール補正
  const predB = (share) => 1 / (share * FSUM)

  console.log(`\n══════ ${lab}　ペア${pairs.length.toLocaleString()}件・${new Set(pairs.map((p) => p.rid)).size}レース ══════`)
  console.log(`確定オッズのΣ(1/o) 中央 ${FSUM.toFixed(3)}`)
  console.log('\n【予測の精度】確定オッズをどれだけ当てられるか（誤差の中央値）')
  for (const [name, fn] of [['そのまま（締切前＝確定と仮定）', (p) => p.pre],
    ['(A) 帯別の縮み率', (p) => predA(p.pre)], ['(B) プール補正', (p) => predB(p.share)]]) {
    const e = pairs.map((p) => Math.abs(fn(p) / p.fin - 1)).sort((x, y) => x - y)
    const w = pairs.filter((p) => Math.abs(fn(p) / p.fin - 1) <= 0.20).length
    console.log(`  ${name.padEnd(28)} 誤差中央 ${(q(e, .5) * 100).toFixed(1)}%  ±20%以内 ${(w / pairs.length * 100).toFixed(1)}%`)
  }

  // ---------- 足切りに使えるか ----------
  const rows = db.prepare(`SELECT race_id,date,lane,p,odds,pay FROM bt WHERE bet_type=?`).all(t)
    .filter((x) => L.has(x.race_id) && L.get(x.race_id).odds.has(x.lane))
    .map((x) => { const v = L.get(x.race_id)
      return { ...x, pre: v.odds.get(x.lane), share: (1 / v.odds.get(x.lane)) / v.sum } })
  if (!rows.length) { console.log('  本命の突き合わせ対象なし'); continue }

  console.log(`\n【足切りに使えるか】本命${rows.length}本（必要倍率=(1÷確率)×${mg}）`)
  const st = (S) => S.length
    ? `${String(S.length).padStart(3)}本 的中${(S.filter((x) => x.pay > 0).length / S.length * 100).toFixed(1).padStart(5)}% 回収${(S.reduce((a, x) => a + x.pay, 0) / S.length * 100).toFixed(1).padStart(6)}%`
    : '  0本'
  const need = (x) => minOddsFor(x.p, mg)
  const A = rows.filter((x) => x.odds >= need(x))
  console.log(`  確定オッズで足切り（＝検証。実行不能） ${st(A)}`)
  for (const [name, fn] of [['締切前オッズそのまま（現行）', (x) => x.pre],
    ['(A) 帯別の縮み率で足切り', (x) => predA(x.pre)], ['(B) プール補正で足切り', (x) => predB(x.share)]]) {
    const S = rows.filter((x) => fn(x) >= need(x))
    const ov = S.filter((x) => x.odds >= need(x)).length
    console.log(`  ${name.padEnd(26)} ${st(S)}  うち確定でも通る ${ov}本`)
  }
}
db.close()
