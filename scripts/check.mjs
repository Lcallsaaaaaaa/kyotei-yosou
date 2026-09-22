// 投入したデータの健全性を確認する。全期間を流す前に必ず通すこと。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (sql, ...p) => db.prepare(sql).all(...p)
const one = (sql, ...p) => db.prepare(sql).get(...p)

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '-')

console.log('=== 件数 ===')
const races = one('SELECT COUNT(*) c FROM races').c
console.log('races', races, '/ entries', one('SELECT COUNT(*) c FROM entries').c,
  '/ payouts', one('SELECT COUNT(*) c FROM payouts').c,
  '/ programs', one('SELECT COUNT(*) c FROM programs').c)

console.log('\n=== 日別レース数 ===')
for (const r of all('SELECT date, COUNT(*) c, COUNT(DISTINCT jcd) v FROM races GROUP BY date ORDER BY date')) {
  console.log(`  ${r.date}  ${r.c}レース  ${r.v}場`)
}

console.log('\n=== 1レースあたりの entries 件数の分布（6以外は異常）===')
for (const r of all(`SELECT n, COUNT(*) c FROM (SELECT race_id, COUNT(*) n FROM entries GROUP BY race_id) GROUP BY n ORDER BY n`)) {
  console.log(`  ${r.n}件: ${r.c}レース`)
}

console.log('\n=== 1レースあたりの programs 件数の分布 ===')
for (const r of all(`SELECT n, COUNT(*) c FROM (SELECT race_id, COUNT(*) n FROM programs GROUP BY race_id) GROUP BY n ORDER BY n`)) {
  console.log(`  ${r.n}件: ${r.c}レース`)
}
const noProg = one(`SELECT COUNT(*) c FROM races r WHERE NOT EXISTS (SELECT 1 FROM programs p WHERE p.race_id=r.race_id)`).c
console.log(`  programs が1件も無いレース: ${noProg}`)

console.log('\n=== 主要フィールドの欠損率 ===')
const e = one('SELECT COUNT(*) c FROM entries').c
for (const [label, sql] of [
  ['entries.course  NULL', 'SELECT COUNT(*) c FROM entries WHERE course IS NULL'],
  ['entries.st      NULL', 'SELECT COUNT(*) c FROM entries WHERE st IS NULL'],
  ['entries.exhibition NULL', 'SELECT COUNT(*) c FROM entries WHERE exhibition IS NULL'],
  ['entries.rank_num NULL', 'SELECT COUNT(*) c FROM entries WHERE rank_num IS NULL'],
]) console.log(`  ${label}: ${one(sql).c} (${pct(one(sql).c, e)})`)

for (const [label, sql] of [
  ['races.kimarite NULL', 'SELECT COUNT(*) c FROM races WHERE kimarite IS NULL'],
  ['races.wind_dir NULL', 'SELECT COUNT(*) c FROM races WHERE wind_dir IS NULL'],
  ['races.wind_speed NULL', 'SELECT COUNT(*) c FROM races WHERE wind_speed IS NULL'],
  ['races.weather  NULL', 'SELECT COUNT(*) c FROM races WHERE weather IS NULL'],
  ['races.deadline NULL', 'SELECT COUNT(*) c FROM races WHERE deadline IS NULL'],
]) console.log(`  ${label}: ${one(sql).c} (${pct(one(sql).c, races)})`)

console.log('\n=== 値の分布（異常値の検出）===')
console.log('決まり手:', all('SELECT kimarite k, COUNT(*) c FROM races GROUP BY k ORDER BY c DESC').map(r => `${r.k}:${r.c}`).join(' '))
console.log('天候    :', all('SELECT weather w, COUNT(*) c FROM races GROUP BY w ORDER BY c DESC').map(r => `${r.w}:${r.c}`).join(' '))
console.log('風向    :', all('SELECT wind_dir d, COUNT(*) c FROM races GROUP BY d ORDER BY c DESC LIMIT 20').map(r => `${r.d}:${r.c}`).join(' '))
console.log('級別    :', all('SELECT grade g, COUNT(*) c FROM programs GROUP BY g ORDER BY c DESC').map(r => `${r.g}:${r.c}`).join(' '))
console.log('着順値  :', all('SELECT rank, COUNT(*) c FROM entries GROUP BY rank ORDER BY c DESC').map(r => `${r.rank}:${r.c}`).join(' '))

console.log('\n=== ★コース別1着率（この数字が予想の土台）===')
const total = one('SELECT COUNT(*) c FROM entries WHERE course IS NOT NULL').c
for (const r of all(`
  SELECT course,
    COUNT(*) n,
    SUM(CASE WHEN rank_num=1 THEN 1 ELSE 0 END) w1,
    SUM(CASE WHEN rank_num=2 THEN 1 ELSE 0 END) w2,
    SUM(CASE WHEN rank_num=3 THEN 1 ELSE 0 END) w3
  FROM entries WHERE course IS NOT NULL GROUP BY course ORDER BY course`)) {
  console.log(`  ${r.course}コース  出走${String(r.n).padStart(5)}  1着${pct(r.w1, r.n).padStart(6)}  2着${pct(r.w2, r.n).padStart(6)}  3着${pct(r.w3, r.n).padStart(6)}`)
}

console.log('\n=== サンプル照合：2026-08-16 大村(24) 1R ===')
console.log(one(`SELECT * FROM races WHERE race_id='20260816-24-01'`))
for (const r of all(`SELECT lane,rank,racer_name,motor_no,boat_no,exhibition,course,st,st_flag FROM entries WHERE race_id='20260816-24-01' ORDER BY lane`)) {
  console.log(' ', r)
}
console.log(' 払戻:', all(`SELECT bet_type,combo,amount,popularity FROM payouts WHERE race_id='20260816-24-01' AND bet_type IN ('sanrentan','sanrenpuku','nirentan')`))
console.log(' 番組:', all(`SELECT lane,racer_name,grade,win_rate_nat,motor_no,motor_top2 FROM programs WHERE race_id='20260816-24-01' ORDER BY lane`))

db.close()
