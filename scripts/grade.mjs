// 開催名からグレードを判定し、進入率・着順への影響を測る。
//
//   node scripts/grade.mjs           判定＋検証＋効果測定
//   node scripts/grade.mjs --apply   racesテーブルに grade 列を書き込む
//
// ★判定の落とし穴
//   「周年記念」はG1の定番だが、下関の「ふく〜る下関オープン14周年記念」は
//   店舗の周年であって一般戦。**キーワードだけでは誤判定する。**
//   そこで判定結果を「1号艇のA1率」で検証する。
//   SG/G1は実測でA1率100%、G3・一般は0〜5%と綺麗に分かれるので答え合わせになる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const all = (s, ...p) => db.prepare(s).all(...p)
const pc = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '  -  ')
const se = (p, n) => Math.sqrt((p * (1 - p)) / n) * 100

/**
 * 開催名 → グレード。上から順に判定する（先に書いたものが優先）
 *
 * ★A1率での検証で判明した落とし穴（2026/08/18）
 *   ・「開設○周年記念」は**場外施設**（ボートピア／ミニット／ウィンボ／BTS／外向発売所）
 *     の周年でも使われる。これらは一般戦なので必ず除外する
 *   ・「グランプリ」はスポンサー名にも出る（餃子屋連盟會GYO-1グランプリ＝一般戦）
 *   ・逆に「市制○周年記念」はG1で使われるのに『開設』が無いので取りこぼす
 */
const GAIBU = /ボートピア|ミニット|ウィンボ|ＢＴＳ|BTS|外向発売所|オラレ|エディウィン|日本トーター杯/

function classify(name) {
  const s = (name ?? '').replace(/[　\s]/g, '')
  const isGaibu = GAIBU.test(s)
  // --- SG（年間9競走）---
  if (/ボートレースクラシック|総理大臣杯/.test(s)) return 'SG'
  if (/ボートレースオールスター|笹川賞/.test(s)) return 'SG'
  if (/グランドチャンピオン/.test(s)) return 'SG'
  if (/オーシャンカップ/.test(s)) return 'SG'
  if (/ボートレースメモリアル|モーターボート記念/.test(s)) return 'SG'
  if (/ボートレースダービー|全日本選手権/.test(s)) return 'SG'
  if (/チャレンジカップ/.test(s)) return 'SG'
  if (/賞金王|グランプリシリーズ|第[\d０-９]+回グランプリ/.test(s)) return 'SG'
  if (/クイーンズクライマックス/.test(s)) return 'SG'
  if (/高松宮記念特別/.test(s)) return 'SG'
  // --- G1 ---
  // 「開設○周年記念」はG1の定番だが、場外施設の周年でも同じ表現を使う。必ず除外する。
  if (!isGaibu && /開設[\d０-９]+周年記念/.test(s)) return 'G1'
  if (!isGaibu && /市制[\d０-９]+周年記念/.test(s)) return 'G1'
  if (/地区選手権/.test(s)) return 'G1'
  if (/全日本王座決定戦/.test(s)) return 'G1'
  if (/レディースチャンピオン|女子王座決定戦/.test(s)) return 'G1'
  if (/マスターズチャンピオン/.test(s)) return 'G1'
  if (/名人戦/.test(s)) return 'G1'
  // --- G2 ---
  if (/モーターボート大賞/.test(s)) return 'G2'
  if (/秩父宮妃記念杯/.test(s)) return 'G2'
  if (/ボートレース甲子園/.test(s)) return 'G2'
  if (/レディースオールスター/.test(s)) return 'G2'
  if (/名人戦|王者決定戦/.test(s)) return 'G2'
  // --- G3 ---
  if (/ヴィーナスシリーズ/.test(s)) return 'G3女子'
  if (/オールレディース|ＡＬ|レディース/.test(s)) return 'G3女子'
  if (/ルーキーシリーズ/.test(s)) return 'G3新人'
  if (/マスターズリーグ/.test(s)) return 'G3シニア'
  return '一般'
}

const GRADES = ['SG', 'G1', 'G2', 'G3女子', 'G3新人', 'G3シニア', '一般']

/**
 * ★名前だけの判定は不安定なので、A1率で補正する。
 * 開催名は主催者が自由に付けられる（場外施設の周年、スポンサー名の「グランプリ」など）が、
 * **A1率は番組編成の実態そのもの**なので、こちらの方が信頼できる。
 * 名前を第一候補にしつつ、実態と食い違ったら実態を採る。
 */
function classifyWithA1(name, a1) {
  const g = classify(name)
  const high = ['SG', 'G1', 'G2'].includes(g)
  if (high && a1 < 0.6) return '一般'   // 格上を名乗るが実態は一般（場外の周年など）
  if (!high && a1 > 0.9) return 'G1'    // 名前では拾えないが実態は格上（市制周年など）
  return g
}

// ---------- ① 判定結果をA1率で検証 ----------
console.log('=== ① 判定結果の検証（A1率が高いほど格上のはず）===\n')
const series = all(`SELECT r.series, COUNT(DISTINCT r.race_id) n,
    AVG(CASE WHEN p.grade='A1' THEN 1.0 ELSE 0.0 END) a1
  FROM races r JOIN programs p ON p.race_id=r.race_id
  WHERE r.series IS NOT NULL GROUP BY r.series`)
const a1map = new Map(series.map((x) => [x.series, x.a1]))
const gradeOf = (name) => classifyWithA1(name, a1map.get(name) ?? 0.2)
const byGrade = {}
for (const s of series) {
  const g = gradeOf(s.series)
  byGrade[g] ??= { series: 0, races: 0, a1sum: 0 }
  byGrade[g].series++
  byGrade[g].races += s.n
  byGrade[g].a1sum += s.a1 * s.n
}
console.log('グレード     開催数   レース数   平均A1率')
for (const g of GRADES) {
  const b = byGrade[g]
  if (!b) continue
  console.log(`${g.padEnd(9, '　')}${String(b.series).padStart(5)}  ${String(b.races).padStart(8)}   ${((b.a1sum / b.races) * 100).toFixed(1)}%`)
}

console.log('\n  ★誤判定の疑い（A1率と判定が矛盾する開催）')
const bad = []
for (const s of series) {
  const g = gradeOf(s.series)
  const high = ['SG', 'G1', 'G2'].includes(g)
  if (high && s.a1 < 0.6) bad.push([g, s.a1, s.series, '格上判定なのにA1率が低い'])
  if (!high && s.a1 > 0.9 && s.n >= 36) bad.push([g, s.a1, s.series, '一般判定なのにA1率が高い'])
}
if (!bad.length) console.log('    なし（判定とA1率が全て整合）')
for (const [g, a1, name, why] of bad.slice(0, 12))
  console.log(`    [${g}] A1率${(a1 * 100).toFixed(0)}%  ${name}  ← ${why}`)

// ---------- ② ★進入率への影響（ユーザー仮説の検証）----------
console.log('\n=== ② グレード別の枠なり進入率（仮説：格上ほど枠なり）===\n')
const races = all(`SELECT r.race_id, r.series, e.lane, e.course FROM races r
  JOIN entries e ON e.race_id=r.race_id WHERE e.course IS NOT NULL`)
const g2 = {}
const cur = new Map()
for (const r of races) {
  if (!cur.has(r.race_id)) cur.set(r.race_id, { series: r.series, mismatch: 0, n: 0 })
  const c = cur.get(r.race_id)
  c.n++
  if (r.lane !== r.course) c.mismatch++
}
for (const [, c] of cur) {
  if (c.n !== 6) continue
  const g = gradeOf(c.series)
  g2[g] ??= { total: 0, waku: 0 }
  g2[g].total++
  if (c.mismatch === 0) g2[g].waku++
}
console.log('グレード     レース数   枠なり進入率   ±誤差')
for (const g of GRADES) {
  const b = g2[g]
  if (!b || b.total < 200) continue
  console.log(`${g.padEnd(9, '　')}${String(b.total).padStart(8)}   ${pc(b.waku, b.total).padStart(8)}    ±${se(b.waku / b.total, b.total).toFixed(1)}pt`)
}

// ---------- ③ グレード別のコース別1着率 ----------
console.log('\n=== ③ グレード別のコース別1着率 ===\n')
const cr = all(`SELECT r.series, e.course c, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course IS NOT NULL GROUP BY r.series, e.course`)
const g3 = {}
for (const r of cr) {
  const g = gradeOf(r.series)
  g3[g] ??= {}
  g3[g][r.c] ??= { n: 0, k: 0 }
  g3[g][r.c].n += r.n
  g3[g][r.c].k += r.k
}
console.log('グレード      1コース  2コース  3コース  4コース  5コース  6コース')
for (const g of GRADES) {
  const b = g3[g]
  if (!b || !b[1] || b[1].n < 1000) continue
  const cells = [1, 2, 3, 4, 5, 6].map((c) => (b[c] ? pc(b[c].k, b[c].n).padStart(7) : '      -'))
  console.log(`${g.padEnd(10, '　')}${cells.join(' ')}`)
}

if (process.argv.includes('--apply')) {
  try { db.exec('ALTER TABLE races ADD COLUMN grade TEXT') } catch {}
  const upd = db.prepare('UPDATE races SET grade=? WHERE series=?')
  db.exec('BEGIN')
  for (const s of series) upd.run(gradeOf(s.series), s.series)
  db.exec('COMMIT')
  console.log('\n✅ races.grade に書き込みました')
  for (const r of all(`SELECT grade, COUNT(*) n FROM races GROUP BY grade ORDER BY n DESC`))
    console.log(`   ${String(r.grade).padEnd(8)} ${r.n}`)
}
db.close()
