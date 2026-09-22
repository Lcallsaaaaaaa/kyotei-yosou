// 取り込んだデータが壊れていないかを毎日ぶん検査する。
// 異常があれば終了コード1を返すので、パイプラインのゲートとして使える。
//
//   node scripts/audit.mjs              直近7日を検査
//   node scripts/audit.mjs --days 30
//   node scripts/audit.mjs --date 2026-08-18
//
// ★この監査が存在する理由：
//   2026/08/18、固定幅ファイルを空白分割で読んでいたため
//   ボートNOが100以上の福岡・芦屋が「場ごと丸ごと」欠落していた（3日分で10%）。
//   総件数だけ見ていても気づけない。場単位のカバレッジと値域を必ず見ること。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const days = Number(flag('days', 7))
const fixedDate = flag('date')

/**
 * ⚠️ toISOString() はUTCに変換するので使わないこと。
 * 日本時間(UTC+9)では日付が1日前にずれ、「直近7日」のつもりが8日分になる。
 */
const p2 = (n) => String(n).padStart(2, '0')
const ymdLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

const maxDate = one('SELECT MAX(date) d FROM races').d
let from, to
if (fixedDate) {
  from = to = fixedDate
} else {
  to = maxDate
  const f = new Date(to + 'T00:00:00')
  f.setDate(f.getDate() - (days - 1))
  from = ymdLocal(f)
}

let fails = 0
let warns = 0
const log = (lvl, name, msg) => {
  if (lvl === 'FAIL') fails++
  if (lvl === 'WARN') warns++
  const tag = lvl === 'OK' ? '  OK ' : lvl === 'WARN' ? ' WARN' : ' FAIL'
  console.log(`${tag} | ${name.padEnd(24)} | ${msg}`)
}

console.log(`=== データ監査  ${from} 〜 ${to} ===\n`)

// 1) 期間内に取り込めた日
const dts = all(
  `SELECT date, COUNT(*) n, COUNT(DISTINCT jcd) v FROM races
   WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`, from, to)
const expectedDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1
if (dts.length === 0) {
  log('FAIL', '日次カバレッジ', '期間内にレースが1件も無い')
} else if (dts.length < expectedDays) {
  const got = new Set(dts.map((d) => d.date))
  const miss = []
  for (let i = 0; i < expectedDays; i++) {
    const d = new Date(from + 'T00:00:00')
    d.setDate(d.getDate() + i)
    const s = ymdLocal(d)
    if (!got.has(s)) miss.push(s)
  }
  log('FAIL', '日次カバレッジ', `欠損日 ${miss.length}件: ${miss.slice(0, 5).join(',')}`)
} else {
  const avgN = (dts.reduce((a, b) => a + b.n, 0) / dts.length).toFixed(0)
  const avgV = (dts.reduce((a, b) => a + b.v, 0) / dts.length).toFixed(1)
  log('OK', '日次カバレッジ', `${dts.length}日 / 平均${avgN}レース・${avgV}場`)
}

const totalRaces = one('SELECT COUNT(*) c FROM races WHERE date BETWEEN ? AND ?', from, to).c

// 2) 1レース6艇（entries）
const badEntries = all(
  `SELECT race_id, COUNT(*) n FROM entries
   WHERE race_id IN (SELECT race_id FROM races WHERE date BETWEEN ? AND ?)
   GROUP BY race_id HAVING n <> 6`, from, to)
if (badEntries.length) {
  log('FAIL', 'entries 6艇', `6件でないレース ${badEntries.length}件: ${badEntries.slice(0, 3).map((r) => `${r.race_id}(${r.n})`).join(' ')}`)
} else {
  log('OK', 'entries 6艇', '全レース6件')
}

// 3) ★場単位カバレッジ（福岡・芦屋事故の検出）
const vlist = all(
  `SELECT r.jcd, COUNT(DISTINCT r.race_id) races, COUNT(DISTINCT p.race_id) prog
   FROM races r LEFT JOIN programs p ON p.race_id = r.race_id
   WHERE r.date BETWEEN ? AND ? GROUP BY r.jcd ORDER BY r.jcd`, from, to)
const vBad = vlist.filter((v) => v.prog === 0)
const vPart = vlist.filter((v) => v.prog > 0 && v.prog < v.races)
if (vBad.length) {
  log('FAIL', '★場単位カバレッジ', `programsが0件の場: jcd=${vBad.map((v) => v.jcd).join(',')} ← パーサ破損の疑い`)
} else if (vPart.length) {
  log('WARN', '★場単位カバレッジ', `一部欠け: ${vPart.map((v) => `jcd${v.jcd}(${v.prog}/${v.races})`).join(' ')}`)
} else {
  log('OK', '★場単位カバレッジ', `${vlist.length}場すべて programs 完備`)
}

// 4) programs も6艇そろっているか
const badProg = all(
  `SELECT race_id, COUNT(*) n FROM programs
   WHERE race_id IN (SELECT race_id FROM races WHERE date BETWEEN ? AND ?)
   GROUP BY race_id HAVING n <> 6`, from, to)
if (badProg.length) {
  log('FAIL', 'programs 6艇', `6件でないレース ${badProg.length}件: ${badProg.slice(0, 3).map((r) => `${r.race_id}(${r.n})`).join(' ')}`)
} else {
  log('OK', 'programs 6艇', '全レース6件')
}

// 5) ★値域チェック（固定幅のズレはここに出る）
const ranges = [
  ['entries.motor_no', 'e.motor_no', 'entries e', 1, 250],
  ['entries.boat_no', 'e.boat_no', 'entries e', 1, 400],
  ['entries.exhibition', 'e.exhibition', 'entries e', 5.5, 9.0],
  ['entries.st', 'e.st', 'entries e', 0, 1],
  ['entries.course', 'e.course', 'entries e', 1, 6],
  ['programs.weight', 'e.weight', 'programs e', 38, 75],
  ['programs.age', 'e.age', 'programs e', 15, 85],
  ['programs.win_rate_nat', 'e.win_rate_nat', 'programs e', 0, 10],
  ['programs.motor_top2', 'e.motor_top2', 'programs e', 0, 100],
  ['programs.boat_top2', 'e.boat_top2', 'programs e', 0, 100],
]
let rangeBad = 0
for (const [name, col, tbl, lo, hi] of ranges) {
  const c = one(
    `SELECT COUNT(*) c FROM ${tbl} JOIN races r ON r.race_id = e.race_id
     WHERE r.date BETWEEN ? AND ? AND ${col} IS NOT NULL AND (${col} < ? OR ${col} > ?)`,
    from, to, lo, hi).c
  if (c > 0) {
    log('FAIL', `値域 ${name}`, `範囲外 ${c}件 ← 桁ズレの疑い`)
    rangeBad++
  }
}
if (!rangeBad) log('OK', '★値域チェック', `${ranges.length}項目すべて範囲内`)

// 6) 級別・着順コードに未知の値が無いか
const grades = all(
  `SELECT DISTINCT p.grade g FROM programs p JOIN races r ON r.race_id = p.race_id
   WHERE r.date BETWEEN ? AND ? AND p.grade IS NOT NULL`, from, to).map((r) => r.g)
const badG = grades.filter((g) => !['A1', 'A2', 'B1', 'B2'].includes(g))
badG.length
  ? log('FAIL', '級別コード', `未知の値: ${badG.join(',')}`)
  : log('OK', '級別コード', grades.sort().join(' '))

const ranks = all(
  `SELECT rank, COUNT(*) n FROM entries e JOIN races r ON r.race_id = e.race_id
   WHERE r.date BETWEEN ? AND ? AND rank IS NOT NULL GROUP BY rank ORDER BY n DESC`, from, to)
const knownRank = /^(0[1-6]|00|[FLKS][0-9]?)$/
const badR = ranks.filter((r) => !knownRank.test(r.rank))
badR.length
  ? log('WARN', '着順コード', `未知の値: ${badR.map((r) => `${r.rank}(${r.n})`).join(' ')}`)
  : log('OK', '着順コード', ranks.map((r) => r.rank).join(' '))

// 7) 決まり手
const KNOWN_K = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ']
const kim = all('SELECT kimarite k, COUNT(*) n FROM races WHERE date BETWEEN ? AND ? GROUP BY k', from, to)
const badK = kim.filter((r) => r.k !== null && !KNOWN_K.includes(r.k))
const nullK = kim.find((r) => r.k === null)?.n ?? 0
if (badK.length) log('FAIL', '決まり手', `未知: ${badK.map((r) => r.k).join(',')}`)
else if (totalRaces && nullK / totalRaces > 0.02) log('WARN', '決まり手', `NULL率 ${((nullK / totalRaces) * 100).toFixed(1)}% (>2%)`)
else log('OK', '決まり手', `${KNOWN_K.length}種・NULL ${nullK}件`)

// 8) 払戻
const noPay = one(
  `SELECT COUNT(*) c FROM races r WHERE r.date BETWEEN ? AND ?
   AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.race_id = r.race_id AND p.bet_type = 'sanrentan')`,
  from, to).c
const badAmt = one(
  `SELECT COUNT(*) c FROM payouts p JOIN races r ON r.race_id = p.race_id
   WHERE r.date BETWEEN ? AND ? AND p.bet_type = 'sanrentan' AND (p.amount < 100 OR p.amount > 10000000)`,
  from, to).c
if (badAmt) log('FAIL', '払戻 3連単', `金額が異常な行 ${badAmt}件`)
else if (totalRaces && noPay / totalRaces > 0.02) log('WARN', '払戻 3連単', `欠落 ${noPay}/${totalRaces}（中止レース等なら正常）`)
else log('OK', '払戻 3連単', `欠落 ${noPay}件・金額すべて正常`)

// 9) ★コース別1着率が歴史的分布から外れていないか（パーサ破損の最終防衛線）
const hist = all(
  `SELECT e.course c, COUNT(*) n, SUM(e.rank_num = 1) w FROM entries e
   JOIN races r ON r.race_id = e.race_id WHERE r.date < ? AND e.course IS NOT NULL GROUP BY e.course`, from)
const cur = all(
  `SELECT e.course c, COUNT(*) n, SUM(e.rank_num = 1) w FROM entries e
   JOIN races r ON r.race_id = e.race_id WHERE r.date BETWEEN ? AND ? AND e.course IS NOT NULL GROUP BY e.course`, from, to)
const hMap = Object.fromEntries(hist.map((r) => [r.c, r.w / r.n]))
const drift = []
for (const r of cur) {
  const h = hMap[r.c]
  if (h === undefined || r.n < 100) continue
  // 二項分布の標準誤差の3倍を超えたら異常とみなす
  const se = Math.sqrt((h * (1 - h)) / r.n)
  const z = Math.abs(r.w / r.n - h) / (se || 1)
  if (z > 3) drift.push(`${r.c}コース ${((r.w / r.n) * 100).toFixed(1)}% vs 過去${(h * 100).toFixed(1)}% (z=${z.toFixed(1)})`)
}
drift.length
  ? log('WARN', 'コース別1着率の乖離', drift.join(' / '))
  : log('OK', 'コース別1着率の乖離', '全コース 3σ以内')

// 10) 孤児
const orphan = one(
  `SELECT COUNT(*) c FROM entries e WHERE NOT EXISTS (SELECT 1 FROM races r WHERE r.race_id = e.race_id)`).c
orphan ? log('WARN', '孤児 entries', `races に無い entries ${orphan}件`) : log('OK', '孤児 entries', 'なし')

console.log(`\n=== 結果: FAIL ${fails} / WARN ${warns} ===`)
if (fails) console.log('⚠️ FAILがある状態のデータで予想を出さないこと。パーサかダウンロードを疑う。')
db.close()
process.exit(fails ? 1 : 0)
