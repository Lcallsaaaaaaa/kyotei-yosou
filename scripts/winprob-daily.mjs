// その日の「1着確率（艇ごと）」を winprob_daily に残す。
//
//   node scripts/winprob-daily.mjs                 今日ぶん
//   node scripts/winprob-daily.mjs --date 2026-10-05
//   node scripts/winprob-daily.mjs --report        貯まり具合を見る
//
// ★なぜ要るか（2026-10-06）
//   単勝・複勝が「締切前に見えているオッズで買えるか」を測るには、
//   **艇ごとの1着確率**と**締切前オッズ**の両方が同じ日にそろっていないといけない。
//
//   締切前オッズ（odds_live）は 2026-08-20 から毎日たまっている。
//   ところが艇ごとの1着確率は `pred` テーブルが **2026-09-05 で止まっていて**
//   （09-06以降は pred3＝組み合わせしか残していない）、
//   重なるのが2週間ぶんしか無かった。そのせいで判定に本数が足りない。
//
//   ここでは **その日の予想ファイル（data/predict-<日付>.json）から
//   艇ごとの1着確率をそのまま写す**。モデルを走らせ直さないので一瞬で終わる。
//
// ★⚠ 過去の日をまとめて取り込んではいけない（2026-10-06に実際にやって破棄した）
//   `data/predict-<日付>.json` は**その日のうちに何度も上書きされる**。
//   auto-bet.mjs → strategy.mjs の runPredict が20分で期限切れのキャッシュを
//   作り直すので、最後の書き込みは**その日の最終レースが終わった後**になる
//   （例：predict-2026-09-17.json の最終更新は 23:27）。
//
//   そのとき使う特徴量は derive.mjs が作り直したもので、**その日の前のレースの結果**
//   が選手の直近成績に入っている。つまり終わったレースの確率が、
//   あとから作られた数字に差し替わっている。
//   実測：当日記録の tansho_daily と突き合わせると、9/06〜9/21 で確率が
//   最大0.24ずれていた。これを検証に使うと回収率が水増しされる
//   （[[boatrace-claim-gate]]・同じ誤りを4回目にするところだった）。
//
//   → **当日ぶんだけを、レースが始まる前に1回写す。** 既にある行は上書きしない
//     （INSERT OR IGNORE）。いちばん早く写した値が正。
//   → --all は意図的に用意していない。過去は `pred` テーブルを使うこと。
//
// ★展示の差し替えも分けて残す
//   chokuzen.mjs が走ったあとの予想ファイルはフルモデルの値になっている。
//   朝の値は chokuzen_log に残っているので、ここでは
//   src 列に 'full'（差し替え後）/'morning'（差し替え前）を書いておく。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 30000')
db.exec(`CREATE TABLE IF NOT EXISTS winprob_daily (
  race_id TEXT NOT NULL, lane INTEGER NOT NULL, date TEXT NOT NULL,
  p REAL, src TEXT, recorded_at TEXT,
  PRIMARY KEY (race_id, lane))`)
db.exec('CREATE INDEX IF NOT EXISTS idx_winprob_daily_date ON winprob_daily(date)')

// ---------- 貯まり具合 ----------
if (argv.includes('--report')) {
  const n = db.prepare('SELECT COUNT(DISTINCT race_id) r, COUNT(*) n FROM winprob_daily').get()
  console.log(`■ winprob_daily　${n.r.toLocaleString()}レース ／ ${n.n.toLocaleString()}行`)
  for (const r of db.prepare(`SELECT date, COUNT(DISTINCT race_id) races,
    SUM(src='full') full_rows FROM winprob_daily GROUP BY date ORDER BY date`).all())
    console.log(`  ${r.date}  ${String(r.races).padStart(4)}レース　（展示差し替え後 ${r.full_rows / 6 | 0}）`)
  // 締切前オッズと両方そろったレース数＝これが判定に使える本数
  const both = db.prepare(`SELECT COUNT(DISTINCT w.race_id) n FROM winprob_daily w
    JOIN odds_live o ON o.race_id = w.race_id AND o.lane = w.lane AND o.mins_before <= 5
    WHERE o.tansho IS NOT NULL`).get().n
  console.log('')
  console.log(`  締切5分前のオッズと両方そろっている：${both.toLocaleString()}レース`)
  console.log('  （pred の 1,738レースに足して、live-odds-test.mjs の判定に使える本数）')
  db.close(); process.exit(0)
}

// ---------- 書き込み ----------
if (argv.includes('--all')) {
  console.error('--all は使えません。予想ファイルは当日のうちに何度も上書きされるので、')
  console.error('過去をまとめて取り込むと「あとから作った数字」が混ざります（先頭の説明を参照）。')
  console.error('過去ぶんは pred テーブルを使ってください。')
  process.exit(1)
}
const DATE = flag('date', TODAY)
if (DATE !== TODAY) {
  console.error(`${DATE} は今日ではありません。過去の日は取り込めません（先頭の説明を参照）`)
  process.exit(1)
}
const dates = [DATE]

// ★上書きしない。いちばん早く写した値を正とする
const ins = db.prepare(`INSERT OR IGNORE INTO winprob_daily (race_id, lane, date, p, src, recorded_at)
  VALUES (?,?,?,?,?,?)`)
// 展示で差し替えたレースは chokuzen_log に載っている
let swapped = new Set()
try { swapped = new Set(db.prepare('SELECT race_id FROM chokuzen_log').all().map((r) => r.race_id)) } catch { /* まだ無い */ }

const at = new Date().toISOString()
let total = 0
for (const date of dates) {
  const f = join(ROOT, 'data', `predict-${date}.json`)
  if (!existsSync(f)) { console.log(`${date}　予想ファイルが無いので飛ばします`); continue }
  let j
  try { j = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { console.log(`${date}　読めません: ${e.message}`); continue }
  // 締切を過ぎたレースは写さない（あとから作った数字が入る恐れがある）
  // ⚠ 当日は races に行が無いことがある。race_meta も見ること（chokuzen.mjs と同じ）
  const dl = new Map()
  for (const r of db.prepare('SELECT race_id, deadline FROM races WHERE date=?').all(date))
    if (r.deadline) dl.set(r.race_id, r.deadline)
  try {
    for (const r of db.prepare('SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL').all(date))
      if (!dl.get(r.race_id)) dl.set(r.race_id, r.deadline)
  } catch { /* race_meta がまだ無い */ }
  if (!dl.size) { console.log(`${date}　締切が1件も分からないので見送ります（番組表の取り込み待ち）`); continue }
  const HHMM = `${p2(new Date().getHours())}:${p2(new Date().getMinutes())}`

  let n = 0, full = 0, skipped = 0, added = 0
  db.exec('BEGIN IMMEDIATE')
  for (const r of j.races ?? []) {
    const bs = r.first ?? []
    if (bs.length !== 6) continue                       // 6艇そろっていないものは残さない
    const sum = bs.reduce((s, x) => s + (x.p ?? 0), 0)
    if (!(sum > 0.9 && sum < 1.1)) continue              // 確率の合計が1から離れていたら疑う
    // ⚠ 締切を過ぎたレースは、この時点のファイルの値が作り直されている可能性がある
    if ((dl.get(r.race_id) ?? '00:00') <= HHMM) { skipped++; continue }
    const src = swapped.has(r.race_id) ? 'full' : 'morning'
    if (src === 'full') full++
    let got = 0
    for (const b of bs) got += ins.run(r.race_id, b.lane, date, b.p, src, at).changes
    if (got) added++
    n++
  }
  db.exec('COMMIT')
  total += added
  console.log(`${date} ${HHMM}　締切前 ${n}レース（新しく残した ${added}・既にある ${n - added}`
    + `・うち展示差し替え後 ${full}）／ 締切を過ぎていて見送った ${skipped}レース`)
}
db.close()
console.log('')
console.log(`合計 ${total}レースを新しく残しました。貯まり具合は --report で見られます`)
console.log('※ 1日に何回でも走らせてよい。既にある行は触らないので、早い時刻の値が残る')
