// 「開催の何日目か」と「レース種別」がコース別成績にどれだけ効くかを測る。
//
//   node scripts/schedule-grade.mjs
//
// ★なぜ効きそうか（仮説）
//   初日   … モーターの仕上がりが未知。選手も水面を把握していない → 荒れる？
//   中盤   … 予選。選手が調整しながら走る
//   最終日 … 優勝戦・準優勝戦。A級中心で番組が組まれる → 堅い？
//   節が進むほど機力が判明し、実力通りに決まるのではないか。
//
// ★日目の導出
//   DBに「何日目」は入っていない（Bファイルのヘッダにはあるが未取得）。
//   同じ場で日付が連続していれば同じ節とみなして番号を振る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const pc = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '  -  ')
const se = (p, n) => Math.sqrt((p * (1 - p)) / n) * 100

// ---------- 節と日目を導出 ----------
const days = all(`SELECT DISTINCT jcd, date FROM races ORDER BY jcd, date`)
const dayNo = new Map() // `${jcd}:${date}` -> 日目
const seriesLen = new Map() // `${jcd}:${date}` -> その節の総日数
{
  const byJcd = new Map()
  for (const d of days) {
    if (!byJcd.has(d.jcd)) byJcd.set(d.jcd, [])
    byJcd.get(d.jcd).push(d.date)
  }
  for (const [jcd, list] of byJcd) {
    let series = []
    const flush = () => {
      series.forEach((dt, i) => {
        dayNo.set(`${jcd}:${dt}`, i + 1)
        seriesLen.set(`${jcd}:${dt}`, series.length)
      })
      series = []
    }
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const gap = (Date.parse(list[i] + 'T00:00:00') - Date.parse(list[i - 1] + 'T00:00:00')) / 86400000
        if (gap > 1) flush()
      }
      series.push(list[i])
    }
    flush()
  }
}

console.log('=== ① 開催の何日目か × イン1着率 ===\n')
const rows = all(`SELECT r.jcd, r.date, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id WHERE e.course=1 GROUP BY r.jcd, r.date`)
const agg = new Map()
for (const r of rows) {
  const d = dayNo.get(`${r.jcd}:${r.date}`)
  const len = seriesLen.get(`${r.jcd}:${r.date}`)
  if (!d || len < 4) continue // 4日未満の変則開催は除く
  const key = d
  if (!agg.has(key)) agg.set(key, { n: 0, k: 0 })
  agg.get(key).n += r.n
  agg.get(key).k += r.k
  // 最終日かどうかも別集計
  const lastKey = d === len ? 'LAST' : null
  if (lastKey) {
    if (!agg.has(lastKey)) agg.set(lastKey, { n: 0, k: 0 })
    agg.get(lastKey).n += r.n
    agg.get(lastKey).k += r.k
  }
}
console.log('日目     レース数   イン1着率   ±誤差')
for (const d of [1, 2, 3, 4, 5, 6, 7]) {
  const a = agg.get(d)
  if (!a || a.n < 500) continue
  console.log(`  ${d}日目 ${String(a.n).padStart(8)}   ${pc(a.k, a.n).padStart(7)}   ±${se(a.k / a.n, a.n).toFixed(1)}pt`)
}
const last = agg.get('LAST')
if (last) console.log(`  最終日 ${String(last.n).padStart(8)}   ${pc(last.k, last.n).padStart(7)}   ±${se(last.k / last.n, last.n).toFixed(1)}pt  （日目を問わず節の最終日）`)

// ---------- ② レース種別 ----------
console.log('\n=== ② レース種別 × イン1着率 ===\n')
console.log('種別               レース数   イン1着率   ±誤差   1号艇A1率')
for (const r of all(`SELECT r.title t, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course=1 AND r.title IS NOT NULL GROUP BY r.title HAVING n >= 300 ORDER BY n DESC`)) {
  const a1 = all(`SELECT AVG(CASE WHEN p.grade='A1' THEN 1.0 ELSE 0.0 END) a
    FROM programs p JOIN races r2 ON r2.race_id=p.race_id WHERE p.lane=1 AND r2.title=?`, r.t)[0]
  console.log(`${r.t.padEnd(16, '　')}${String(r.n).padStart(8)}   ${pc(r.k, r.n).padStart(7)}   ±${se(r.k / r.n, r.n).toFixed(1)}pt   ${((a1?.a ?? 0) * 100).toFixed(1)}%`)
}

// ---------- ③ 日目の効果は「番組編成」の交絡ではないか ----------
console.log('\n=== ③ ★交絡の確認：日目の差は1号艇の強さで説明できるか ===\n')
console.log('日目   1号艇A1率   1号艇の級別優位   イン1着率')
const byDay = new Map()
for (const p of all(`SELECT r.jcd, r.date, p.lane, p.grade FROM programs p JOIN races r ON r.race_id=p.race_id`)) {
  const d = dayNo.get(`${p.jcd}:${p.date}`)
  const len = seriesLen.get(`${p.jcd}:${p.date}`)
  if (!d || len < 4 || d > 7) continue
  if (!byDay.has(d)) byDay.set(d, { a1: 0, n1: 0, g1: 0, gOther: 0, nOther: 0 })
  const b = byDay.get(d)
  const g = { A1: 3, A2: 2, B1: 1, B2: 0 }[p.grade] ?? 1
  if (p.lane === 1) { b.n1++; b.g1 += g; if (p.grade === 'A1') b.a1++ }
  else { b.nOther++; b.gOther += g }
}
for (const d of [...byDay.keys()].sort((a, b) => a - b)) {
  const b = byDay.get(d)
  const a = agg.get(d)
  if (!a || a.n < 500) continue
  console.log(`  ${d}    ${((b.a1 / b.n1) * 100).toFixed(1).padStart(5)}%      ${(b.g1 / b.n1 - b.gOther / b.nOther).toFixed(2).padStart(6)}         ${pc(a.k, a.n)}`)
}
console.log('\n  ※ A1率・級別優位が日目とともに上がっているなら、日目の効果ではなく番組編成が正体。')
db.close()
