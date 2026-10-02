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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
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
const races = (main.races ?? []).map((r) => {
  if (!target.includes(r.race_id)) return r
  const n = byId.get(r.race_id); if (!n) return r
  // 本命が入れ替わった回数も数える（どれくらい効いているかの目安）
  const a = (r.first ?? []).slice().sort((x, y) => y.p - x.p)[0]
  const b = (n.first ?? []).slice().sort((x, y) => y.p - x.p)[0]
  if (a && b && a.lane !== b.lane) moved++
  swapped++
  return n
})

console.log(`入れ替え ${swapped}レース（うち本命が変わったのは ${moved}レース）`)
if (DRY) { console.log('--dry なので書き換えません'); process.exit(0) }

// ★書き込みは一時ファイル → 置き換え。api.mjs が読んでいる最中の半端な中身を避ける
main.races = races
main.chokuzen_at = `${DATE} ${HHMM}`
const w = MAIN + '.tmp'
writeFileSync(w, JSON.stringify(main))
renameSync(w, MAIN)
try { unlinkSync(TMP) } catch { /* 残っても害は無い */ }
console.log(`${MAIN} を更新しました（サイトには次の送信で反映されます）`)
