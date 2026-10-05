// 複勝で回収率100%を超える選び方があるか、総当たりで探す。
//
//   node --max-old-space-size=4096 scripts/fukusho-sweep.mjs
//
// ★オッズは「選ぶため」には使わない。
//   オッズで絞ると確定オッズ前提の幻になる（単勝で3回やった [[boatrace-claim-gate]]）。
//   精算にだけ確定払戻を使う。これなら「朝に決めて買う」が成立する。
//
// ★前半で探して、後半で確かめる。
//   前半でいちばん良かった条件を後半に当てて、残るかどうかだけを見る。
//   前半の最良を「見つけた」と言わない。**後半で残ったものだけが候補**。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
console.log('材料を読み込んでいます…')

const pay = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='fukusho'`).all())
  pay.set(r.race_id + '|' + r.combo, r.amount)

const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num IS NOT NULL`).all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}

const grade = new Map(db.prepare(`SELECT race_id, grade FROM races`).all().map((r) => [r.race_id, r.grade ?? '一般']))

const P = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1 ORDER BY race_id, lane`).all()) {
  if (!P.has(r.race_id)) P.set(r.race_id, [])
  P.get(r.race_id).push({ lane: r.lane, p: r.p })
}
db.close()

// 1レース1行に畳む
const races = []
for (const [id, bs0] of P) {
  if (!rank.has(id)) continue
  const bs = [...bs0].sort((a, b) => b.p - a.p)
  if (!bs.some((b) => pay.has(id + '|' + b.lane))) continue
  races.push({ id, ymd: id.slice(0, 8), jcd: Number(id.slice(9, 11)), grade: grade.get(id) ?? '一般', bs })
}
races.sort((a, b) => a.id.localeCompare(b.id))
const CUT = races[Math.floor(races.length / 2)].ymd
console.log(`${races.length.toLocaleString()}レース　前半 〜${CUT} ／ 後半 ${CUT}〜`)
console.log('')

const VEN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑',
  9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島',
  17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

/** 条件に当てはまる艇を買って、確定払戻で精算する。 */
function evalRule(rule, which) {
  let n = 0, hit = 0, ret = 0
  for (const r of races) {
    if (which === 0 ? r.ymd >= CUT : r.ymd < CUT) continue
    for (const b of rule.pick(r)) {
      n++
      if ((rank.get(r.id).get(b.lane) ?? 9) <= 2) { hit++; ret += pay.get(r.id + '|' + b.lane) ?? 0 }
    }
  }
  return { n, hit: n ? hit / n * 100 : 0, roi: n ? ret / (n * 100) * 100 : 0 }
}

// ---------- 条件をたくさん作る ----------
const rules = []
const add = (label, pick) => rules.push({ label, pick })

// ① 順位（本命・2番手…）× 確率の帯
for (const [ri, rn] of [[0, '本命'], [1, '2番手'], [2, '3番手']])
  for (const lo of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
    for (const hi of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]) {
      if (hi <= lo) continue
      add(`${rn}・確率${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}%`,
        (r) => { const b = r.bs[ri]; return b && b.p >= lo && b.p < hi ? [b] : [] })
    }

// ② 枠番 × 確率の帯
for (const lane of [1, 2, 3, 4, 5, 6])
  for (const lo of [0, 0.3, 0.5, 0.7])
    for (const hi of [0.3, 0.5, 0.7, 1.01]) {
      if (hi <= lo) continue
      add(`${lane}号艇・確率${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}%`,
        (r) => { const b = r.bs.find((x) => x.lane === lane); return b && b.p >= lo && b.p < hi ? [b] : [] })
    }

// ③ 場 × 本命
for (const jcd of Object.keys(VEN).map(Number))
  for (const lo of [0, 0.5, 0.8])
    add(`${VEN[jcd]}・本命・確率${(lo * 100).toFixed(0)}%以上`,
      (r) => (r.jcd === jcd && r.bs[0].p >= lo ? [r.bs[0]] : []))

// ④ グレード × 本命
for (const g of ['一般', 'G3', 'G2', 'G1', 'SG'])
  add(`${g}・本命`, (r) => (r.grade === g ? [r.bs[0]] : []))

// ⑤ 本命と2番手の差（混戦かどうか）
for (const [lo, hi, lbl] of [[0, 0.05, '僅差'], [0.05, 0.15, 'やや差'], [0.15, 0.3, '差あり'], [0.3, 1, '一本かぶり']])
  for (const [ri, rn] of [[0, '本命'], [1, '2番手']])
    add(`${lbl}（1位と2位の差${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}pt）・${rn}`,
      (r) => { const d = r.bs[0].p - r.bs[1].p; return d >= lo && d < hi ? [r.bs[ri]] : [] })

// ⑥ 2点・3点買い
for (const k of [2, 3])
  for (const lo of [0, 0.3, 0.5])
    add(`上位${k}点・本命確率${(lo * 100).toFixed(0)}%以上`,
      (r) => (r.bs[0].p >= lo ? r.bs.slice(0, k) : []))

console.log(`${rules.length}通りを試します`)
console.log('')

// ---------- 前半で探す ----------
const MIN_N = 300
const first = rules.map((r) => ({ ...r, a: evalRule(r, 0) })).filter((r) => r.a.n >= MIN_N)
first.sort((x, y) => y.a.roi - x.a.roi)

console.log(`【前半でいちばん良かった10通り】（${MIN_N}点以上のものだけ）`)
console.log('  回収率   的中率     点数   条件')
for (const r of first.slice(0, 10))
  console.log(`  ${r.a.roi.toFixed(1).padStart(6)}%  ${r.a.hit.toFixed(1).padStart(6)}%  ${String(r.a.n.toLocaleString()).padStart(7)}  ${r.label}`)
console.log('')

// ---------- 後半で確かめる ----------
console.log('【その10通りを、後半に当てる】')
console.log('  前半     後半      点数   条件')
let survived = 0
for (const r of first.slice(0, 10)) {
  const b = evalRule(r, 1)
  if (b.roi >= 100) survived++
  console.log(`  ${r.a.roi.toFixed(1).padStart(6)}% → ${b.roi.toFixed(1).padStart(6)}%  ${String(b.n.toLocaleString()).padStart(7)}  ${r.label}`)
}
console.log('')

// ---------- 全部の条件で、天井はどこか ----------
const both = rules.map((r) => ({ label: r.label, a: evalRule(r, 0), b: evalRule(r, 1) }))
  .filter((r) => r.a.n >= MIN_N && r.b.n >= MIN_N)
const over = both.filter((r) => r.a.roi >= 100 && r.b.roi >= 100)
const ceilA = Math.max(...both.map((r) => r.a.roi))
const ceilB = Math.max(...both.map((r) => r.b.roi))

console.log('【結論】')
console.log(`  試した条件　　　　　　　${both.length}通り（前半・後半とも${MIN_N}点以上）`)
console.log(`  前半の天井　　　　　　　${ceilA.toFixed(1)}%`)
console.log(`  後半の天井　　　　　　　${ceilB.toFixed(1)}%`)
console.log(`  前半も後半も100%超え　　${over.length}通り`)
if (over.length) {
  console.log('')
  console.log('  前半     後半      点数   条件')
  for (const r of over.sort((x, y) => y.b.roi - x.b.roi).slice(0, 15))
    console.log(`  ${r.a.roi.toFixed(1).padStart(6)}% → ${r.b.roi.toFixed(1).padStart(6)}%  ${String(r.b.n.toLocaleString()).padStart(7)}  ${r.label}`)
} else {
  console.log('')
  console.log('  → オッズを使わない選び方では、複勝で100%を超えるものは見つかりませんでした。')
}
