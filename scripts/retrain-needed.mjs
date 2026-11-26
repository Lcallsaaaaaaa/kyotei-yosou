// 今このタイミングで再学習を回すべきかを判断するだけの係。回すのは呼び出し側。
//
//   node scripts/retrain-needed.mjs        終了コード 0=回す / 1=回さない
//   node scripts/retrain-needed.mjs --why  理由だけ見る（回数を数えない）
//
// ★なぜ要るか（2026-10-20）
//   再学習は night2.sh の 9/9（最後）に置いてあった。night2 が 1〜8 の途中で死ぬと
//   **9 まで届かず、再学習が丸ごと飛ぶ**。10/18・10/19・10/20 と3日続けて飛び、
//   本番モデルは 10/17 のまま止まっていた。誰も気づかなかった。
//   「夜のバッチの最後」ではなく、**自分の時間を持った別のタスク**にする。
//
// ★ただし時間を決め打ちにしてはいけない
//   04:00 に固定しても、その時刻に night2 の重い処理（derive/addbefore/predict）が
//   まだ走っていれば、7.8GBしかないこの機械では**食い合って両方死ぬ**。
//   そこで「30分ごとに様子を見て、安全で、まだやっていなければ回す」形にする。
//
// ★判断すること（上から順に、1つでも引っかかれば回さない）
//   1. 今日もう学習した           … model_history に今日の行がある
//   2. 重い処理が走っている       … derive / addbefore / predict / model5
//   3. 昨日ぶんの特徴量がまだ無い   … feat の最終日が昨日より前（学習する中身が増えていない）
//   4. 今日もう3回試した           … 失敗し続けるときに機械を焼かないための上限
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { heavyRunning } from './heavy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WHY_ONLY = process.argv.includes('--why')
const MAX_TRIES = 3

const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
// ⚠ 日付は地方時で作る。toISOString() や「UTC+9時間」で作ると
//   この機械（すでにJST）では9時間ずれる。
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const YEST = ymd(new Date(now.getTime() - 24 * 3600e3))

const no = (reason) => { console.log(`回さない: ${reason}`); process.exit(1) }
const yes = (reason) => {
  console.log(`回す: ${reason}`)
  if (!WHY_ONLY) {
    state.tries = (state.tries ?? 0) + 1
    try { writeFileSync(STATE, JSON.stringify(state)) } catch { /* 書けなくても回す */ }
  }
  process.exit(0)
}

const STATE = join(ROOT, 'data', 'retrain-state.json')
// ⚠ 先頭のBOMを落としてから JSON.parse すること（2026-10-20に踏んだ）。
//   PowerShell の `Out-File -Encoding utf8` は **BOM付き**で書く。BOMが付いていると
//   JSON.parse が例外になり、**黙って回数0に戻って上限が効かなくなる**。
//   回数を数えるファイルでこれが起きると、失敗し続けるときに何度でも学習を起こしてしまう。
const readState = () => {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8').replace(/^﻿/, ''))
    if (s.date === TODAY) return s
  } catch { /* 無い・壊れ・日付違い */ }
  return { date: TODAY, tries: 0 }
}
const state = readState()

// ---------- 1. 今日もう学習したか ----------
let db
try { db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true }) }
catch (e) { no(`DBが開けません（${String(e.message).slice(0, 60)}）`) }
db.exec('PRAGMA busy_timeout = 8000')

let last, latestRace
try {
  last = db.prepare(`SELECT run_at, verdict FROM model_history ORDER BY run_at DESC LIMIT 1`).get()
  // ★races ではなく feat を見ること。
  //   races は build（night2 の 1/9）で入るが、学習が実際に使うのは derive（3/9）が作る feat。
  //   races だけ見ると「結果は入っているのに特徴量が無い」状態で学習に入り、
  //   前回と同じデータで10分かけて作り直すだけになる。
  latestRace = db.prepare(`SELECT MAX(r.date) d FROM feat f JOIN races r ON r.race_id = f.race_id`).get()?.d ?? null
} catch (e) { db.close(); no(`DBが読めません（他の処理が握っています）`) }
db.close()

if (last?.run_at) {
  // run_at は UTC の ISO。JSTの日付に直して今日かどうかを見る（kesson.mjs と同じ見方）
  const d = new Date(new Date(last.run_at).getTime() + 9 * 3600e3)
  if (d.toISOString().slice(0, 10) === TODAY) no(`今日もう学習しました（${last.verdict}）`)
}

// ---------- 2. 重い処理が走っていないか ----------
// ★判定は scripts/heavy.mjs に集約。model5 も数えるので再学習の二重起動も防げる。
//   chokuzen（5分ごとの直前差し替え）は数えない。数えると昼間は永久に動けない。
if (heavyRunning()) no('重い処理が走っています（夜のバッチ中）')

// ---------- 3. 学習する中身が増えているか ----------
// ★結果（races）が昨日まで入っていないなら、前回と同じデータで学習することになる。
//   10分かけて同じものを作り直すだけなので待つ。night.sh（05:00）が結果を入れる。
if (!latestRace) no('特徴量(feat)が読めません')
if (latestRace < YEST) no(`昨日(${YEST})ぶんの特徴量がまだありません（最終 ${latestRace}）。derive を待ちます`)

// ---------- 4. 試した回数 ----------
if ((state.tries ?? 0) >= MAX_TRIES) no(`今日もう${state.tries}回試しました（上限${MAX_TRIES}）`)

yes(`前回は ${last?.run_at ? new Date(new Date(last.run_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : '記録なし'}／特徴量は ${latestRace} まで／${(state.tries ?? 0) + 1}回目`)
