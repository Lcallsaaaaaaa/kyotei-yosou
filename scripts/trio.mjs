// 3連単を「オッズを一切見ずに」買って100%を超えられるか検証する。
//
//   node --max-old-space-size=8192 scripts/trio.mjs
//
// ★なぜこれを試すか
//   締切前オッズから確定オッズは当てられない（predodds.mjs：誤差中央38%）。
//   オッズで足切りする設計が使えない以上、残る道は
//   **オッズを一切使わず、モデルの確率だけで買って控除率25%を超える** こと。
//   3連単は平均72倍つくので、的中率が低くても成立する可能性がある。
//
// ★ただし前提を取り違えないこと
//   「オッズが高い」だけでは勝てない。市場がその高さを正しく値付けしていれば
//   回収は控除率どおり75%に落ち着く。勝てるのは**市場の値付けが外れている**場合だけ。
//   オッズを見ずにそれを当てられるか、が本当の問い。
//
// ★足切りは全部「買う時点で分かるもの」だけ
//   モデルの確率・艇番・場・レース番号・全国勝率・モーター2連率。
//   オッズ（確定も締切前も）は条件に一切使わない。払戻の計算にだけ使う。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const rng = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const q = (a, x) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * x))] : NaN

// ---------- 実払戻（3連単） ----------
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id,combo,amount FROM payouts WHERE bet_type='sanrentan' AND amount>0`).all())
  PAY.set(r.race_id + '|' + r.combo, r.amount / 100)
console.log(`3連単の実払戻 ${PAY.size.toLocaleString()}レース`)

// ---------- レース情報 ----------
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,grade FROM races`).all())
  RC.set(r.race_id, r)

// ---------- 予想（120通り） ----------
// メモリを食うので、レースごとに上位だけ残す
const TOPN = 12
const races = new Map()
for (const r of db.prepare(`SELECT race_id,combo,p FROM wk3`).all()) {
  let a = races.get(r.race_id); if (!a) { a = []; races.set(r.race_id, a) }
  a.push(r)
  if (a.length > 400) { a.sort((x, y) => y.p - x.p); a.length = TOPN }
}
const R = []
for (const [rid, a] of races) {
  const rc = RC.get(rid); if (!rc || !PAY.size) continue
  a.sort((x, y) => y.p - x.p)
  const top = a.slice(0, TOPN)
  const hitCombo = [...PAY.keys()].length ? null : null
  R.push({ rid, date: rc.date, jcd: rc.jcd, rno: rc.race_no, grade: rc.grade, top })
}
races.clear()
console.log(`予想のあるレース ${R.length.toLocaleString()}\n`)

const payOf = (rid, combo) => PAY.get(rid + '|' + combo) ?? 0
const settled = R.filter((x) => [...x.top].some(() => true) && PAY.has(x.rid + '|' + x.top[0].combo) !== undefined)

// 決着したレースだけ（払戻テーブルにそのレースがある）
const hasRes = new Set()
for (const k of PAY.keys()) hasRes.add(k.slice(0, k.indexOf('|')))
const USE = R.filter((x) => hasRes.has(x.rid))
console.log(`決着まで確認できるレース ${USE.length.toLocaleString()}\n`)

// ---------- 検定 ----------
function report(label, picks) {
  // picks: [{rid, combos:[...], date}]
  const n = picks.reduce((a, x) => a + x.combos.length, 0)
  if (n < 200) return console.log(`  ${label.padEnd(34)} 該当${n}点（少なすぎ）`)
  let ret = 0, hit = 0
  const byMon = new Map(), arr = []
  for (const x of picks) {
    for (const c of x.combos) {
      const p = payOf(x.rid, c)
      ret += p; if (p > 0) hit++
      arr.push(p)
      const m = x.date.slice(0, 7)
      const q2 = byMon.get(m) || [0, 0]; q2[0]++; q2[1] += p; byMon.set(m, q2)
    }
  }
  const roi = ret / n
  let over = 0
  for (const [, v] of byMon) if (v[1] / v[0] > 1) over++
  // ブートストラップ
  const rand = rng(824), bs = []
  for (let b = 0; b < 5000; b++) {
    let s = 0
    for (let i = 0; i < arr.length; i++) s += arr[(rand() * arr.length) | 0]
    bs.push(s / arr.length)
  }
  bs.sort((a, b) => a - b)
  const ws = arr.filter((v) => v > 0).sort((a, b) => b - a)
  const ex10 = ws.slice(10).reduce((a, v) => a + v, 0) / n
  console.log(`  ${label.padEnd(34)} ${String(n).padStart(6)}点 的中${(hit / n * 100).toFixed(2).padStart(5)}% 回収${(roi * 100).toFixed(1).padStart(6)}% 月${over}/${byMon.size} 上位10除外${(ex10 * 100).toFixed(1)}% ブート90%[${(bs[250] * 100).toFixed(0)},${(bs[4750] * 100).toFixed(0)}]`)
}

console.log('════ ① 確率が高い順に N 点買う（オッズ条件なし・全レース）════')
for (const n of [1, 2, 3, 6, 10, 12])
  report(`上位${n}点`, USE.map((x) => ({ rid: x.rid, date: x.date, combos: x.top.slice(0, n).map((c) => c.combo) })))

console.log('\n════ ② 本命の確率で絞る（＝自信のあるレースだけ）════')
for (const th of [0.05, 0.10, 0.15, 0.20, 0.30])
  report(`最有力の確率${(th * 100).toFixed(0)}%以上・1点`,
    USE.filter((x) => x.top[0].p >= th).map((x) => ({ rid: x.rid, date: x.date, combos: [x.top[0].combo] })))

console.log('\n════ ③ 逆に「荒れそうなレース」だけ（最有力が低い）════')
for (const th of [0.03, 0.05, 0.08])
  report(`最有力の確率${(th * 100).toFixed(0)}%未満・上位6点`,
    USE.filter((x) => x.top[0].p < th).map((x) => ({ rid: x.rid, date: x.date, combos: x.top.slice(0, 6).map((c) => c.combo) })))

console.log('\n════ ④ 1号艇が1着でない組み合わせだけ（人気薄狙い）════')
for (const n of [1, 3, 6]) {
  const picks = USE.map((x) => {
    const c = x.top.filter((y) => !y.combo.startsWith('1')).slice(0, n)
    return c.length ? { rid: x.rid, date: x.date, combos: c.map((y) => y.combo) } : null
  }).filter(Boolean)
  report(`1号艇1着を除く上位${n}点`, picks)
}

console.log('\n════ ⑤ 上位N点の確率合計で絞る（読みやすいレース）════')
for (const th of [0.3, 0.4, 0.5]) {
  const picks = USE.map((x) => {
    const s = x.top.slice(0, 6).reduce((a, y) => a + y.p, 0)
    return s >= th ? { rid: x.rid, date: x.date, combos: x.top.slice(0, 6).map((y) => y.combo) } : null
  }).filter(Boolean)
  report(`上位6点の確率合計${(th * 100).toFixed(0)}%以上・6点`, picks)
}
db.close()
