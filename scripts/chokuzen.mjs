// 展示が出たレースの予想を、フルモデルで作り直してサイトに反映する。
//
//   node scripts/chokuzen.mjs                  今日ぶん
//   node scripts/chokuzen.mjs --date 2026-10-01
//   node scripts/chokuzen.mjs --dry            書き換えずに、何が変わるかだけ出す
//
// ★なぜやるか（2026-10-02に実測）
//   モデルは2本ある。朝モデル(194項目)と、展示タイム・チルト・風・波まで使う
//   フルモデル(226項目)。predict.mjs は「直前情報があればフルモデル」という作りだが、
//   predict.mjs が走るのは 02:00 と 06:00 だけで、その時刻に展示は終わっていない。
//   つまり**フルモデルは毎晩25分かけて学習しながら、一度も使われていなかった**。
//
//   学習外23日・3,445レースで測った差：
//     logloss 0.3230 → 0.3173（対の検定で t=5.37・p<0.000001）
//     展示タイム1位のズレ +1.70pt → −0.36pt（朝モデルの偏りが消える）
//     上位10%で絞ったときの的中 3連複2点 62.2%→66.8% / 3連単4点 41.6%→47.8%
//
// ★売っている買い目は動かさない
//   サイトが出す買い目は haishin_daily / tansho_daily / spot_daily（記録テーブル）
//   から作られる。このスクリプトが触るのは data/predict-<日付>.json だけで、
//   そこから作られるのは **1着確率・2連対率・展開予想・注目レース** の表示だけ。
//   朝に売った買い目はそのまま残る。
//
// ★終わったレースは書き換えない
//   締切を過ぎたレースの1着確率を後から差し替えると、「予想していた数字」ではなく
//   「あとから作った数字」を実績の横に並べることになる。締切前のレースだけ入れ替える。
//
// ★公式サイトへは取りに行かない
//   predict.mjs は既定では当日の全レース（130〜170ページ）を同時6本で取りに行く。
//   朝の1〜2回なら問題ないが、数分おきに回すと1時間で2,000ページを超えて遮断される。
//   直前情報は before.mjs --live が常駐で集めているので --before-db でDBから読む。
import './prio.mjs'   // 予定タスク経由だと BelowNormal になる。自分で上げる
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DRY = argv.includes('--dry')

const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
// ⚠ 日付は toISOString(UTC) で比べないこと。深夜0〜9時に前日と判定される。
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const DATE = flag('date', TODAY)
const HHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`
const ymd = DATE.replace(/-/g, '')

const MAIN = join(ROOT, 'data', `predict-${DATE}.json`)
const TMP = join(ROOT, 'data', `chokuzen-${DATE}.json`)

if (!existsSync(MAIN)) { console.log(`${MAIN} がありません（朝のバッチがまだ）。何もしません`); process.exit(0) }

// ---------- 二重起動を止める（2026-10-28） ----------
// ★なぜ要るか：この日、有料会員の中身がまるごと出なくなった。
//   原因は predict-<日付>.json の破損で、壊れ方はこうだった：
//     …"chokuzen_at":"10:15"}  at":"10:03"}
//     （新しい内容のうしろに、古い内容の尻尾が残っている）
//   一時ファイル名が**固定**だったため、2本のこの処理が同じ .tmp を掴み、
//   後発が短い内容を書いたあと、先発が自分の残りを後ろへ書き足した。
//   タスクは5分ごと・上限10分なので、機械が重い日は前の回が残ったまま次が動く。
//   展開予想APIはこのファイルを読むので、**壊れた瞬間に有料の中身が全滅**する。
//
//   鍵と、プロセスごとに違う一時ファイル名の**両方**で塞ぐ。
//   （鍵が取れない場面があっても、名前が違えば混ざらない）
const LOCK = join(ROOT, 'data', `chokuzen-${DATE}.lock`)
if (!DRY) {
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  if (existsSync(LOCK)) {
    let pid = null
    try { pid = JSON.parse(readFileSync(LOCK, 'utf8')).pid } catch { /* 壊れていても年齢で見る */ }
    const ageMin = (Date.now() - statSync(LOCK).mtimeMs) / 60000
    if (pid && alive(pid) && ageMin < 15) {
      console.log(`前の差し替えがまだ動いています（PID ${pid}・${Math.round(ageMin)}分前）。今回は見送ります`)
      process.exit(0)
    }
    try { unlinkSync(LOCK) } catch { /* 消せなくても下で上書きする */ }
  }
  try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) } catch { /* 書けなくても進む */ }
  process.on('exit', () => { try { if (existsSync(LOCK)) unlinkSync(LOCK) } catch { /* 15分で無効になる */ } })
}

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 10000')

// ---------- 直前情報がそろっているレース ----------
// predict.mjs の hasFull と同じ条件：6艇ぶんの展示タイムがあり、波も分かっていること
const ready = new Set()
{
  const ex = new Map()
  for (const r of db.prepare(`SELECT race_id, COUNT(*) n FROM before_info
    WHERE substr(race_id,1,8)=? AND ex_time IS NOT NULL GROUP BY race_id`).all(ymd)) ex.set(r.race_id, r.n)
  for (const r of db.prepare(`SELECT race_id FROM before_race
    WHERE substr(race_id,1,8)=? AND wave IS NOT NULL`).all(ymd))
    if (ex.get(r.race_id) === 6) ready.add(r.race_id)
}

// ---------- 締切 ----------
const DL = new Map()
for (const r of db.prepare(`SELECT race_id, deadline FROM races WHERE date=?`).all(DATE)) if (r.deadline) DL.set(r.race_id, r.deadline)
try {
  for (const r of db.prepare(`SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL`).all(DATE))
    if (!DL.get(r.race_id)) DL.set(r.race_id, r.deadline)
} catch { /* race_meta がまだ無い */ }
db.close()

// 締切前かどうか。今日でない日は「全部終わっている」とみなす（過去を書き換えない）
const open = (rid) => DATE === TODAY && (DL.get(rid) ?? '00:00') > HHMM

const target = [...ready].filter(open)
console.log(`${DATE} ${HHMM}　展示あり ${ready.size}レース ／ うち締切前 ${target.length}レース`)
if (!target.length) { console.log('入れ替える対象がありません'); process.exit(0) }

// ---------- フルモデルで作り直す ----------
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--max-old-space-size=6144', join(ROOT, 'scripts', 'predict.mjs'),
    '--date', DATE, '--trio', '--json', '--before-db', '--out', TMP], { cwd: ROOT })
  let last = ''
  p.stdout.on('data', (d) => { const l = String(d).trim().split('\n').filter(Boolean).pop(); if (l) last = l })
  p.stderr.on('data', (d) => { const l = String(d).trim(); if (l) last = l })
  p.on('close', (c) => c === 0 ? resolve() : reject(new Error(`predict.mjs が失敗（code ${c}）: ${last}`)))
})

const main = JSON.parse(readFileSync(MAIN, 'utf8'))
const fresh = JSON.parse(readFileSync(TMP, 'utf8'))
const byId = new Map((fresh.races ?? []).map((r) => [r.race_id, r]))

let swapped = 0, moved = 0
const ledger = []          // 朝モデルとフルモデルを並べて残す（下で chokuzen_log へ）
const races = (main.races ?? []).map((r) => {
  if (!target.includes(r.race_id)) return r
  const n = byId.get(r.race_id); if (!n) return r
  // 本命が入れ替わった回数も数える（どれくらい効いているかの目安）
  const a = (r.first ?? []).slice().sort((x, y) => y.p - x.p)[0]
  const b = (n.first ?? []).slice().sort((x, y) => y.p - x.p)[0]
  if (a && b && a.lane !== b.lane) moved++
  swapped++
  ledger.push([r, n])
  return n
})

console.log(`入れ替え ${swapped}レース（うち本命が変わったのは ${moved}レース）`)
if (DRY) { console.log('--dry なので書き換えません'); process.exit(0) }

// ★書き込みは一時ファイル → 置き換え。api.mjs が読んでいる最中の半端な中身を避ける
main.races = races
main.chokuzen_at = `${DATE} ${HHMM}`
// ⚠ 一時ファイル名にPIDを入れること（2026-10-28）。
//   固定名 `MAIN + '.tmp'` だと、2本が同時に動いたとき同じファイルを掴み、
//   **新しい内容の後ろに古い内容の尻尾が残って壊れる**。実際に有料が全滅した。
//   上の鍵と二重の守り。鍵をすり抜けても、名前が違えば混ざらない。
const w = `${MAIN}.${process.pid}.tmp`
writeFileSync(w, JSON.stringify(main))
// ★置き換える前に、書けたものが本当に読めるJSONか確かめる。
//   壊れたものを本番へ出すくらいなら、今回は見送るほうがよい。
try { JSON.parse(readFileSync(w, 'utf8')) }
catch (e) {
  try { unlinkSync(w) } catch { /* 残っても害は無い */ }
  console.log(`書き出したものが壊れていました（${String(e.message).slice(0, 60)}）。差し替えません`)
  process.exit(1)
}
renameSync(w, MAIN)
try { unlinkSync(TMP) } catch { /* 残っても害は無い */ }
console.log(`${MAIN} を更新しました（サイトには次の送信で反映されます）`)

// ---------- 朝モデルとフルモデルを並べて残す ----------
// ★なぜここで残すか（2026-10-06）
//   フルモデルが本当に効いているかは、2.5時間かけて一括で測り直すより
//   **毎日ここで1行ずつ貯める**ほうが筋がいい。走らせ直す必要も無く、
//   日が経つほど判定が確かになる。読み出しは scripts/chokuzen-report.mjs。
//
//   ⚠ 1レースにつき最初の1回だけ入れる（INSERT OR IGNORE）。
//     chokuzen は数分おきに走るので、2回目以降の「朝モデル側」は
//     すでにフルモデルの値になっていて、比べる相手にならない。
const probs = (xs) => (xs ?? []).slice().sort((a, b) => b.p - a.p)
  .map((x) => `${x.lane}:${x.p.toFixed(4)}`).join('|')
const combos = (xs, k = 4) => (xs ?? []).slice(0, k).map((x) => x.combo).join(',')

try {
  const wdb = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  wdb.exec('PRAGMA busy_timeout = 10000')
  wdb.exec(`CREATE TABLE IF NOT EXISTS chokuzen_log (
    race_id TEXT PRIMARY KEY, date TEXT NOT NULL, at TEXT NOT NULL,
    m_probs TEXT, m_conf REAL, m_tri TEXT, m_puku TEXT,
    f_probs TEXT, f_conf REAL, f_tri TEXT, f_puku TEXT)`)
  wdb.exec('CREATE INDEX IF NOT EXISTS idx_chokuzen_log_date ON chokuzen_log(date)')
  const ins = wdb.prepare(`INSERT OR IGNORE INTO chokuzen_log
    (race_id, date, at, m_probs, m_conf, m_tri, m_puku, f_probs, f_conf, f_tri, f_puku)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  let kept = 0
  wdb.exec('BEGIN IMMEDIATE')
  for (const [m, f] of ledger) {
    const r = ins.run(m.race_id, DATE, `${DATE} ${HHMM}`,
      probs(m.first), m.conf ?? null, combos(m.sanrentan), combos(m.sanrenpuku),
      probs(f.first), f.conf ?? null, combos(f.sanrentan), combos(f.sanrenpuku))
    kept += r.changes
  }
  wdb.exec('COMMIT')
  wdb.close()
  console.log(`比較の記録 +${kept}レース（既に記録済みの ${ledger.length - kept}レースは触らず）`)
} catch (e) {
  // ★記録に失敗しても差し替え自体は成功している。ここで落とさない
  console.log(`比較の記録に失敗（差し替えは成功しています）: ${e.message}`)
}
