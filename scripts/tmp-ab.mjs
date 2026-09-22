import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/auto-bet.mjs'
let s = readFileSync(p, 'utf8')
const NL = '\n'

// ① 校正表を読み込む（import と初期化）
if (!s.includes("from './calib.mjs'")) {
  s = s.replace("import * as S from './strategy.mjs'",
    "import * as S from './strategy.mjs'" + NL + "import { loadCalib, shouldBuy } from './calib.mjs'")
}
if (!s.includes('const CAL =')) {
  const anchor = 'const TYPES = ['
  s = s.replace(anchor, [
    '// ★確率の校正表。モデルは自信過剰（0.8と言って実際71.5%）なので、',
    '//   そのまま必要倍率を出すと低すぎて買いすぎる。歩進検証の実績に引き直す。',
    '//   これを入れると余裕1.3で回収 141.95% → 165.58%（実測）。',
    'const CAL = S.USE_CALIB ? loadCalib(db, \'wi1\') : null',
    'if (CAL) log(`確率の校正表 ${CAL.size}升を読み込み`)',
    '',
    anchor,
  ].join(NL))
}

// ② 単勝の pick を全6艇に
const a2 = "    pick: (x) => x.first?.[0], minP: S.MIN_P, maxP: S.MAX_P, maxWR: S.MAX_WR,"
if (!s.includes(a2)) { console.log('N2'); process.exit(1) }
s = s.replace(a2, [
  '    // ★2026-08-31: 本命1艇 → 全6艇。1レースで複数該当したら全部買う。',
  '    //   1艇に絞ると回収が9〜21pt下がる（実測）。実際に条件を満たすのは見張りの9.1%。',
  '    picks: (x) => (S.ALL_LANES ? (x.first ?? []) : (x.first ? [x.first[0]] : [])),',
  '    minP: S.MIN_P, maxP: S.MAX_P, maxWR: S.MAX_WR,',
].join(NL))

// ③ 候補づくりを複数艇対応に
const a3 = `  T.cands = [...withDL.values()]
    .map((x) => {
      const f = T.pick(x); if (!f || !x.dl) return null
      const wr = WR.get(x.race_id + '|' + f.lane)
      return { x, lane: f.lane, name: f.name, p: f.p, wr, dl: x.dl, mins: x.mins }
    })`
if (!s.includes(a3)) { console.log('N3'); process.exit(1) }
s = s.replace(a3, `  T.cands = [...withDL.values()]
    .flatMap((x) => {
      if (!x.dl) return []
      // picks があれば複数艇、無ければ従来どおり1艇
      const fs = T.picks ? T.picks(x) : (T.pick(x) ? [T.pick(x)] : [])
      return fs.map((f) => ({ x, lane: f.lane, name: f.name, p: f.p,
        wr: WR.get(x.race_id + '|' + f.lane), dl: x.dl, mins: x.mins }))
    })`)

// ④ 判定に校正を入れる
const a4 = `      const need = T.fixedOdds ?? S.minOddsFor(c.p, T.margin)
      const decision = o == null ? 'no_odds' : o >= need ? 'buy' : 'skip'`
if (!s.includes(a4)) { console.log('N4'); process.exit(1) }
s = s.replace(a4, `      // ★必要倍率は買い目ごとに違う（1÷確率×余裕）。固定倍率ではない。
      //   単勝は確率を校正してから計算する（自信過剰の補正）。
      let need, pUsed = c.p
      if (T.fixedOdds != null) { need = T.fixedOdds }
      else if (CAL && T.key === 'tansho' && o != null) {
        const r = shouldBuy(CAL, c.p, o, T.margin)
        need = r.need; pUsed = r.p
      } else { need = S.minOddsFor(c.p, T.margin) }
      const decision = o == null ? 'no_odds' : o >= need ? 'buy' : 'skip'`)

writeFileSync(p, s)
console.log('ok')
