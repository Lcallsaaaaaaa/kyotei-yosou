// 3連単・3連複・単勝に、同じ「自信 × オッズ下限」の走査をかける。
//
//   node scripts/scan-all.mjs
//
// ★なぜやり直すか
//   単勝で回収110.6%が見つかったのは「自信の高い本命を、オッズが付くときだけ買う」
//   という走査による。同じ走査を3連複にはかけていなかった。
//   3連単には過去にかけたが、そのときはモデルが古く（条件付き・直前情報なし）、
//   オッズも一部の期間しか無かった。全部揃った今、公平に並べ直す。
//
// ★選択バイアスへの対処
//   閾値を多数試して最良を報告するのは、回収率279%を出したときと同じ誤り。
//   ここでは (1) 前半・後半の両方で100%超か (2) 閾値に対して単調か
//   の2点を必ず併記する。単調でない跳ね値は偶然とみなす。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'we1'), T3 = flag('t3', 'we3')

// ---------- 予想を読む ----------
console.log('読み込み中...')
const mdl = new Map()
for (const r of all(`SELECT race_id, combo, p, month FROM ${T3}`)) {
  let g = mdl.get(r.race_id); if (!g) { g = { month: r.month, rows: [] }; mdl.set(r.race_id, g) }
  g.rows.push(r)
}
const tanP = new Map()
for (const r of all(`SELECT race_id, lane, p, y FROM ${T1}`)) {
  let g = tanP.get(r.race_id); if (!g) { g = []; tanP.set(r.race_id, g) }
  g.push(r)
}
// ---------- オッズ ----------
const o3t = new Map(), o3f = new Map(), oTan = new Map()
for (const r of all(`SELECT race_id, combo, odds FROM odds3t WHERE odds IS NOT NULL`)) {
  let m = o3t.get(r.race_id); if (!m) { m = new Map(); o3t.set(r.race_id, m) } m.set(r.combo, r.odds)
}
for (const r of all(`SELECT race_id, combo, odds FROM odds3f WHERE odds IS NOT NULL`)) {
  let m = o3f.get(r.race_id); if (!m) { m = new Map(); o3f.set(r.race_id, m) } m.set(r.combo, r.odds)
}
for (const r of all(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`)) {
  let m = oTan.get(r.race_id); if (!m) { m = new Map(); oTan.set(r.race_id, m) } m.set(r.lane, r.tansho)
}
// ---------- 的中 ----------
const win = { sanrentan: new Map(), sanrenpuku: new Map(), tansho: new Map() }
for (const r of all(`SELECT race_id, bet_type, combo FROM payouts WHERE bet_type IN ('sanrentan','sanrenpuku','tansho')`))
  win[r.bet_type].set(r.race_id, r.combo)

// ---------- 各券種の買い目を作る ----------
/** 3連単・3連複：確率の高い順にnPick点。「自信」＝その合計、「最低オッズ」＝一番安い買い目 */
function buildCombo(kind, nPick) {
  const isBox = kind === 'sanrenpuku'
  const oddsSrc = isBox ? o3f : o3t
  const out = []
  for (const [rid, g] of mdl) {
    const om = oddsSrc.get(rid); if (!om) continue
    const box = new Map()
    const tot = g.rows.reduce((a, x) => a + x.p, 0)
    for (const x of g.rows) {
      const k = isBox ? x.combo.split('-').map(Number).sort((a, b) => a - b).join('-') : x.combo
      box.set(k, (box.get(k) ?? 0) + x.p / tot)
    }
    const cand = [...box].sort((a, b) => b[1] - a[1]).slice(0, nPick)
      .map(([c, p]) => ({ c, p, o: om.get(c) })).filter((x) => x.o != null)
    if (cand.length < nPick) continue
    const w = win[kind].get(rid)
    const h = cand.find((x) => x.c === w)
    out.push({ month: g.month, conf: cand.reduce((a, x) => a + x.p, 0),
      minO: Math.min(...cand.map((x) => x.o)), cost: nPick * 100, back: h ? h.o * 100 : 0, hit: h ? 1 : 0 })
  }
  return out
}
/** 単勝：本命1点 */
function buildTan() {
  const out = []
  for (const [rid, g] of tanP) {
    const om = oTan.get(rid); if (!om) continue
    const best = g.reduce((a, b) => (b.p > a.p ? b : a))
    const o = om.get(best.lane); if (o == null) continue
    const w = win.tansho.get(rid)
    const hit = String(best.lane) === w ? 1 : 0
    out.push({ month: mdl.get(rid)?.month ?? '', conf: best.p, minO: o, cost: 100, back: hit ? o * 100 : 0, hit })
  }
  return out
}

const st = (a) => {
  if (!a.length) return null
  const c = a.reduce((x, r) => x + r.cost, 0), b = a.reduce((x, r) => x + r.back, 0)
  return { n: a.length, hit: a.reduce((x, r) => x + r.hit, 0) / a.length, roi: b / c }
}

const SETS = [
  ['単勝1点', buildTan(), [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0], [0]],
  ['3連複1点', buildCombo('sanrenpuku', 1), [0, 3, 5, 8, 12, 20, 30], [0, 0.3, 0.4]],
  ['3連複3点', buildCombo('sanrenpuku', 3), [0, 3, 5, 8, 12, 20], [0, 0.5, 0.6]],
  ['3連単1点', buildCombo('sanrentan', 1), [0, 5, 10, 20, 40, 80], [0, 0.1, 0.15]],
  ['3連単5点', buildCombo('sanrentan', 5), [0, 5, 8, 12, 20, 40], [0, 0.4, 0.5]],
]
const months = [...new Set(SETS[0][1].map((r) => r.month))].filter(Boolean).sort()
const half = Math.floor(months.length / 2)
const isE = (r) => months.indexOf(r.month) < half
console.log(`月 ${months.join(' ')}\n`)

for (const [label, rows, thresholds, confs] of SETS) {
  console.log(`===== ${label}（${rows.length.toLocaleString()}レース） =====`)
  for (const cf of confs) {
    const base = cf ? rows.filter((r) => r.conf >= cf) : rows
    if (base.length < 300) continue
    console.log(`  自信${cf ? (cf * 100).toFixed(0) + '%以上' : '制限なし'}`)
    console.log('    オッズ下限   点数    的中率   回収率   前半     後半   両方100%超')
    let prev = null, mono = true
    for (const th of thresholds) {
      const s = base.filter((r) => r.minO >= th)
      const t = st(s); if (!t || t.n < 150) continue
      const e = st(s.filter(isE)), l = st(s.filter((r) => !isE(r)))
      const ok = e && l && e.roi >= 1 && l.roi >= 1
      if (prev !== null && t.roi < prev - 0.02) mono = false
      prev = t.roi
      console.log(`    ${String(th).padStart(6)}倍  ${String(t.n).padStart(6)}   ${(t.hit * 100).toFixed(1).padStart(5)}%  ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(e ? (e.roi * 100).toFixed(1) : '-').padStart(6)}%  ${(l ? (l.roi * 100).toFixed(1) : '-').padStart(6)}%   ${ok ? '★' : ''}`)
    }
    console.log(`    → 閾値に対して${mono ? '単調に上昇（構造あり）' : '単調でない（偶然の可能性）'}`)
  }
  console.log('')
}
console.log('※ ★＝前半・後半の両方で100%超。単調でなければ跳ね値は偶然とみなす')
db.close()
