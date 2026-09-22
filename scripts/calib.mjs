// 確率の校正表。判定・見張り表・検証で同じものを使う。
//
//   import { loadCalib, calibrate, requiredOdds } from './calib.mjs'
//
// ★なぜ校正が要るか
//   モデルは全確率帯で自信過剰。0.8と言って実際71.55%（−9.09pt）。
//   そのまま必要倍率を計算すると低く出て買いすぎる。
//   過去の実績に引き直すと、余裕1.3で回収 141.95% → 165.58%（+23.6pt）。
//
// ★升目の切り方
//   確率帯 × オッズ帯の2次元。3次元（＋市場比）も試したが改善しなかった。
//   件数の少ない升目は元の値に寄せる（縮小推定 K=300）。
//
// ★時点を守る
//   校正表は歩進検証の結果（既定 wi1）から作る。これは
//   「毎月その月より前だけで学習して当月を予想した」もので、未来は混ざっていない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 確率の区切り */
export const PB = [0, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
/** オッズの区切り */
export const OB = [0, 1.5, 2.2, 3.2, 5, 8, 15, 30, 9999]
export const binOf = (B, v) => { for (let i = 1; i < B.length; i++) if (v < B[i]) return i - 1; return B.length - 2 }

/** 校正表を作る。db は開いた DatabaseSync */
export function loadCalib(db, table = 'wi1', K = 300) {
  const OD = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
    OD.set(r.race_id + '|' + r.lane, r.tansho)
  const M = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${table}`).iterate()) {
    const od = OD.get(r.race_id + '|' + r.lane)
    if (!(od > 0)) continue
    const k = binOf(PB, r.p) + '|' + binOf(OB, od)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.y; a.sp += r.p
  }
  const cal = new Map()
  for (const [k, a] of M) {
    const obs = a.h / a.n, said = a.sp / a.n
    const w = a.n / (a.n + K)
    cal.set(k, (w * obs + (1 - w) * said) / Math.max(said, 1e-9))
  }
  if (cal.size < 20) throw new Error(`校正表が作れない（${table} が空か、オッズが無い）`)
  return cal
}

/** オッズが分かっているときの校正後の確率 */
export function calibrate(cal, pRaw, odds) {
  const c = cal.get(binOf(PB, pRaw) + '|' + binOf(OB, odds))
  return c ? Math.min(0.999, Math.max(1e-6, pRaw * c)) : pRaw
}

/**
 * オッズが分からないときの必要倍率。
 * オッズ帯ごとに校正後の確率が変わるので、帯を順に見て
 * 「その帯に入るオッズで、必要倍率を満たす一番低い値」を返す。
 * 返り値 null は「どの帯でも成立しない＝実質買えない」。
 */
export function requiredOdds(cal, pRaw, margin) {
  for (let b = 0; b < OB.length - 1; b++) {
    const p = calibrate(cal, pRaw, (OB[b] + Math.min(OB[b + 1], OB[b] * 2 + 1)) / 2)
    const need = (1 / p) * margin
    if (need >= OB[b] && need < OB[b + 1]) return { odds: need, p }
    if (need < OB[b]) return { odds: OB[b], p }
  }
  return null
}

/** 買うかどうか。オッズが分かっているときはこちらを使う（判定の本体） */
export function shouldBuy(cal, pRaw, odds, margin) {
  if (!(odds > 0)) return null
  const p = calibrate(cal, pRaw, odds)
  const need = (1 / p) * margin
  return { buy: odds >= need, p, need }
}
