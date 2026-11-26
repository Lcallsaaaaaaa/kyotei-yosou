// その日の「出来ているはずのもの」が欠けていたら、自分で作り直す。
//
//   node scripts/ensure-day.mjs            足りないものだけ作る
//   node scripts/ensure-day.mjs --dry      何をするかだけ出す（実行しない）
//   node scripts/ensure-day.mjs --date YYYY-MM-DD
//
// ★なぜ要るか（2026-10-20）
//   10/18・10/19・10/20と**3日続けて**夜間バッチが途中で死に、
//   その日の配信・無料枠・企画枠が1件も作られなかった。毎回手で流して復旧している。
//
//   見張り（kesson.mjs）は**正しく検知していた**。足りないのは
//   「**気づいたあとに直す係**」だけだった。これがそれ。
//
// ★決まり
//   ・揃っていれば何もしない（数秒で終わる）。足りないものだけ作る
//   ・**締切を過ぎたレースは元々記録されない**（haishin/tansho/spot 側の守り）。
//     早い時間に動くほど救えるので30分ごとに回す
//   ・重い処理（derive/addbefore/predict）は夜間バッチが走っている最中は**やらない**。
//     二重に走らせると、ただでさえ足りないメモリを食い合って共倒れになる
//   ・鍵を取って二重起動しない
//
// ★順番は night2.sh と同じにすること（勝手に変えると壊れる）
//   1. 番組表（download→extract→build）
//   2. グレード判定（grade.mjs --apply）
//      ⚠ **無料枠より先**。races.grade が空のまま予想すると高確率帯の較正が壊れ、
//        2026-08-19〜09-05 は前向き実測が検証値96.3%に対し84.0%まで落ちた。
//   3. 特徴量 → 予想（重い）
//   4. 配信・無料枠・B2・企画枠（軽い。ここが商品）
//
// ★日付の作り方
//   ⚠ **素の `toISOString().slice(0,10)` は使わないこと。** あれはUTCの日付なので、
//     JSTの深夜0〜9時に**前日**と判定される（kesson.mjs にも同じ注意がある）。
//   ✅ 次の2つはどちらも正しく、全時間帯で一致する（2026-10-24に実測で確認）：
//        new Date(Date.now() + 9*3600e3).toISOString().slice(0,10)   ← JST固定
//        `${now.getFullYear()}-${p2(now.getMonth()+1)}-${p2(now.getDate())}`  ← 機械の地方時
//     `Date.now()` は機械のタイムゾーンに影響されないので、+9時間してUTCで描けばJSTになる。
//   ⚠ 2026-10-20に「9時間足すとUTC+18になり15時以降が翌日になる」と書いたが**これは誤り**。
//     誤った理由で直しても害は無かったが、同じ誤解で他を「直す」と壊すので残しておく。
//     ここで地方時を使っているのは、機械がJST固定で運用されているため（どちらでもよい）。
import { execFileSync } from 'node:child_process'
import { setPriority } from 'node:os'
import { existsSync, statSync, readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { heavyRunning } from './heavy.mjs'
// ★判断は ensure-plan.mjs（副作用なし）に置いて、test-ensure-plan.mjs で確かめる。
//   ここに判断を書き戻さないこと。目視(--dry)しか手段が無くなり、10/22の事故が再発する。
import { decideProgram, decideHeavy, decideLight, decideContent, decideResults, sinceDate, isRequired } from './ensure-plan.mjs'
import { checkpointIfLarge, walMB } from './wal.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = flag('date') ?? `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const YMD = TODAY.replace(/-/g, '')
const HHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`
const log = (...a) => console.log(HHMM, ...a)

// ---------- 鍵（二重起動を止める）----------
const LOCK = join(ROOT, 'data', 'ensure-day.lock')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
if (!DRY) {
  if (existsSync(LOCK)) {
    let pid = null
    try { pid = JSON.parse(readFileSync(LOCK, 'utf8')).pid } catch { /* 壊れていても年齢で見る */ }
    const age = (Date.now() - statSync(LOCK).mtimeMs) / 60000
    // ⚠ 鍵の有効期限は短くすること（2026-10-30に踏んだ）。
    //   90分にしていたため、13:33に固まった1本が13:57の回まで塞いでいた。
    //   タスクの上限（PT25M）で**親タスクを殺しても node の子は生き残る**ので、
    //   鍵だけが残って次を止め続ける。タスクの窓（30分）より短くする。
    if (pid && alive(pid) && age < 25) { log(`別の ensure-day が動いています（PID ${pid}・${Math.round(age)}分前）`); process.exit(0) }
    if (pid && alive(pid)) {
      // 25分を超えて生きているのは固まっている。片付けてから進む。
      log(`前の ensure-day（PID ${pid}）が ${Math.round(age)}分 固まっているので片付けます`)
      try { process.kill(pid) } catch { /* 権限が無ければ鍵だけ外す */ }
    }
    try { rmSync(LOCK) } catch { /* 消せなくても下で上書きする */ }
  }
  try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) } catch { /* 書けなくても進む */ }
  process.on('exit', () => { try { if (existsSync(LOCK)) rmSync(LOCK) } catch { /* 90分で無効になる */ } })
}

// ★重い処理が走っているかの判定は scripts/heavy.mjs に集約してある。
//   走っているなら、そちらが作るのを待つ。奪い合うと両方死ぬ。

// ★自分の優先度を上げる（2026-11-11）。
//   予定タスクから起動されたものは **BelowNormal** で動く（Task Scheduler の
//   既定 Priority=7。競艇のタスクは全部これで、一度も指定していなかった）。
//   搭載7.8GB・ページング47,000回/秒 のこの機械では、BelowNormal の処理は
//   いつまでも進まず、11/11 は作り直しが6時間15分走って時間切れになった。
//   -7 は Windows で ABOVE_NORMAL。下で呼ぶ derive・predict などの子も引き継ぐ。
try { setPriority(-7) } catch { /* 上げられなくても続ける */ }

const did = []
const failed = []
// ★「やらなかった」を「揃っている」と言わないための記録（2026-11-09）。
//   重い処理が走っている間は予想づくりを次の回にまわすが、そのとき did も failed も
//   空のままなので、最後に **「すべて揃っています」と出ていた**。
//   11/09、当日の予想ファイルが無いのに --dry がそう答えた。
//   復旧（recover.mjs）はこの一行を成否の判断に使うので、嘘をつかせてはいけない。
const deferred = []
// ★その日の商品（配信・無料枠・B2・企画枠）がまだ揃っていないか（2026-11-14）。
//   揃うまで記事づくりへ進ませないための印。予想が先、記事は後。
let productsPending = false
const note = (ok, msg) => { (ok ? did : failed).push(msg) }

// ★DBを開く前にWALを見る（2026-10-24に踏んだ）。
//   再起動で addbefore が中断され、9.98GBのWALが残った。読み取り専用では畳めないので
//   「DBが読めません」で毎回見送り、その日の配信・無料枠が作られなかった。
//   畳むのに41秒。ここを通しておけば半日止まらずに済んだ。
//   ⚠ did/failed より後に置くこと。前に置くと宣言前参照で実行時に落ちる。
if (!DRY) {
  const w = checkpointIfLarge({ log })
  if (w.done) did.push(`WALを畳んだ（${w.mb.toFixed(0)}MB・${w.sec}秒）`)
}

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 8000')
// ★「0件」と「分からない」を混ぜないこと。
//   読めなかったときに 0 を返すと、**DBが忙しいだけなのに欠品と誤判定して**
//   同じ処理を何度も流してしまう。読めなければ null を返し、その回は見送る。
const num = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.n ?? 0 } catch { return null } }

// ---------- 済んだ印（0件が正解の日に鳴り続けないため）----------
// ★「表に行があるか」だけで判定すると、**0件が正しい日に毎回欠品と誤判定する**。
//   B2判定は条件に合うレースが無ければ1行も書かない（1日平均0.85本・0本の日が大半）。
//   配信・無料枠も、締切を全部過ぎてから動けば0件になる。
//   そこで「流した」こと自体を日付つきで覚えて、二度流さない。
const STATE = join(ROOT, 'data', 'ensure-day-state.json')
// ⚠ 先頭のBOMを落としてから JSON.parse すること（2026-10-20に踏んだ）。
//   PowerShell の `Out-File -Encoding utf8` は **BOM付き**で書く。BOMが付いていると
//   JSON.parse が例外になり、黙って「まだ何もしていない」状態に戻る＝重複実行の元。
const state = (() => {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8').replace(/^﻿/, ''))
    if (s.date === TODAY) return s
  } catch { /* 無い・壊れ */ }
  return { date: TODAY, done: [] }
})()
const ranAlready = (step) => state.done.includes(step)
const markRan = (step) => {
  if (DRY || state.done.includes(step)) return
  state.done.push(step)
  try { writeFileSync(STATE, JSON.stringify(state)) } catch { /* 書けなくても今回は進む */ }
}

/**
 * 複数のスクリプトの出力を、まとめて1つのファイルに書く（morning.sh と同じ形）。
 * ★一時ファイルに書いてから差し替える。読み手（見張り）に半端な中身を見せないため。
 */
const runToFile = (outFile, argvList, heap = null) => {
  if (DRY) { for (const a of argvList) log(`  → ${a[0]}`); return true }
  const tmp = `${outFile}.${process.pid}.tmp`
  let body = ''
  let ok = true
  for (const argv of argvList) {
    const a = heap ? [`--max-old-space-size=${heap}`, ...argv] : argv
    log(`  → ${argv[0]}`)
    try {
      body += execFileSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8', timeout: 12 * 60_000 })
    } catch (e) {
      // 1本落ちても他は残す。全部空になるより、出せるものを出す。
      log(`  ✗ ${argv[0]} に失敗: ${String(e.message).slice(0, 100)}`)
      body += String(e.stdout ?? '')
      ok = false
    }
  }
  if (body.trim().length < 500) { log(`  ✗ 中身が ${body.length} 文字しかないので差し替えません`); return false }
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, outFile)
  } catch (e) { log(`  ✗ 書き出しに失敗: ${String(e.message).slice(0, 80)}`); return false }
  log(`  ${outFile} に ${Math.round(body.length / 1024)}KB`)
  return ok || body.trim().length >= 500
}

const run = (label, args, heap = null) => {
  const a = heap ? [`--max-old-space-size=${heap}`, ...args] : args
  log(`  → ${label}`)
  if (DRY) return true
  // ⚠ 1工程の上限は、タスクの窓（30分）より短くすること（2026-10-30に直した）。
  //   60分にしていたので、1本が長引くと直す係ごと窓からはみ出し、
  //   `IgnoreNew` で次の回が飛ぶ。実測では derive でも5分ほどで終わる。
  try { execFileSync(process.execPath, a, { cwd: ROOT, stdio: 'inherit', timeout: 18 * 60_000 }); return true }
  catch (e) { log(`  ✗ ${label} に失敗: ${String(e.message).slice(0, 140)}`); return false }
}

log(`=== ${TODAY} の持ち物を確かめます ===`)

// ---------- 1. 番組表 ----------
// ★ race_meta で見てはいけない。あれは predict.mjs が ensureMeta で自分で作るので、
//   「予想が済んだ」印であって「番組表が来た」印ではない。素は programs。
// ★組み立ては必ず範囲を絞る（2026-10-22に踏んだ）
//   `build.mjs --no-analyze` だけで呼ぶと**4年ぶん2,300ファイルを毎回作り直す**。
//   機械が空いている02:00なら通るが、昼間は60分を超えて run() の制限に当たり
//   ETIMEDOUT。しかも番組表の経路には回数の上限を付けていなかったので、
//   **30分ごとに60分の無駄骨を永久に繰り返していた**（10/22に10:00と11:30で実測）。
//   `--since` で直近だけにすると **60分超 → 3.4秒**。
const SINCE = sinceDate(now)
const saveState = () => { try { writeFileSync(STATE, JSON.stringify(state)) } catch { /* 書けなくても進む */ } }
const programN = num(`SELECT COUNT(*) n FROM programs WHERE substr(race_id,1,8)=?`, YMD)
if (programN == null) {
  log('DBが読めません（他の処理が握っています）。この回は見送ります')
  db.close()
  process.exit(0)
}
let hasProgram = programN > 0
const progPlan = decideProgram({ programs: programN, tries: state.prog ?? 0, date: TODAY, since: SINCE })
log(progPlan.reason)
if (progPlan.run) {
  if (!DRY) { state.prog = (state.prog ?? 0) + 1; saveState() }
  const labels = ['番組表の取り込み', '展開', `組み立て（${SINCE}以降・ANALYZEは飛ばす）`]
  let ok = true
  for (let i = 0; i < progPlan.argv.length && ok; i++) ok = run(labels[i] ?? progPlan.argv[i][0], progPlan.argv[i])
  note(ok, ok ? '番組表を作った' : '★番組表に失敗')
  hasProgram = ok
  if (!ok) log('番組表が無いと先へ進めません')
}

// ---------- 2〜3. グレード判定 → 特徴量 → 予想 ----------
const pf = join(ROOT, 'data', `predict-${TODAY}.json`)
const hasPredict = () => existsSync(pf) && statSync(pf).size > 1000
// ★重い処理は1日2回まで（ensure-plan.mjs の HEAVY_MAX）。
//   メモリ不足で予想が落ちている最中に30分ごとに derive（40分・8GB）を回すと、
//   足りないメモリをさらに奪って**状況を悪くする**。2回試して駄目なら人を呼ぶ。
// ⚠ heavyRunning() は PowerShell を起こすので、必要なときだけ呼ぶ。
const needHeavy = hasProgram && !hasPredict()
const heavyPlan = decideHeavy({
  hasProgram, hasPredict: hasPredict(),
  heavyRunning: needHeavy ? heavyRunning() : false,
  tries: state.heavy ?? 0, lastAt: state.heavyAt ?? null, now: Date.now(), date: TODAY,
})
if (hasProgram) log(heavyPlan.reason)
// 予想がまだ無いのに作りにいかなかった＝先送り。揃ってはいない。
if (hasProgram && !heavyPlan.run && !hasPredict()) deferred.push(`予想（${heavyPlan.reason}）`)
if (heavyPlan.run) {
  if (!DRY) { state.heavy = (state.heavy ?? 0) + 1; state.heavyAt = Date.now(); saveState() }
  // 名前と必要なメモリ。derive/addbefore は8GB、予想は6GBを要求する。
  const spec = { 'scripts/grade.mjs': ['グレード判定', null], 'scripts/derive.mjs': ['特徴量', 8192],
    'scripts/addbefore.mjs': ['直前情報の付加', 8192], 'scripts/predict.mjs': ['予想', 6144] }
  // ★任意の工程が落ちても先へ進む（2026-10-22）。
  //   `A && B && C` で繋いでいたせいで、addbefore のメモリ不足だけで
  //   予想・配信・無料枠・B2・企画枠が全部道連れになり、その日の商品が消えた。
  //   予想は --nobefore で呼ぶので直前情報は使っていない。止める理由が無かった。
  let ok = true
  for (const argv of heavyPlan.argv) {
    const [label, heap] = spec[argv[0]] ?? [argv[0], null]
    const r = run(label, argv, heap)
    if (r) continue
    if (isRequired(argv[0])) { ok = false; break }
    log(`  （${label} は飛ばして先へ進みます。商品には要りません）`)
    did.push(`${label}は飛ばした`)
  }
  note(ok, ok ? '予想を作った' : '★予想に失敗')
}

// ---------- 4. 配信・無料枠・B2・企画枠（軽い。ここが商品）----------
if (hasPredict()) {
  // ★企画枠の格上判定は「行数が0のとき」だけ回す（2026-10-20に踏んだ）。
  //   以前は会場ごとに1本ずつ投げていて最大24本になり、addbefore がDBを握っている間は
  //   busy_timeout を毎回待って**8分近く固まった**。1本のクエリにまとめてある。
  //   判定は kesson.mjs と同じ「1号艇のA1率」。開催名のキーワードでは
  //   2026-09-13〜16に徳山のG1を4日続けて取り逃している。
  const spotN = num(`SELECT COUNT(DISTINCT race_id) n FROM spot_daily WHERE date=?`, TODAY)
  const gradeDay = () => {
    try {
      const r = db.prepare(`SELECT MAX(rate) n FROM (
        SELECT CAST(SUM(CASE WHEN grade='A1' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS rate
        FROM programs WHERE substr(race_id,1,8)=? AND lane=1
        GROUP BY substr(race_id,10,2))`).get(YMD)
      return (r?.n ?? 0) >= 0.7
    } catch { return true }   // 判定できないときは spot 側の --auto に任せる
  }
  const counts = {
    配信: num(`SELECT COUNT(DISTINCT race_id) n FROM haishin_daily WHERE date=?`, TODAY),
    無料枠: num(`SELECT COUNT(*) n FROM tansho_daily WHERE date=?`, TODAY),
    B2判定: num(`SELECT COUNT(*) n FROM b2_daily WHERE date=?`, TODAY),
    企画枠: spotN,
  }
  for (const step of decideLight({
    hasPredict: true, counts, date: TODAY, done: state.done ?? [],
    gradeDay: spotN === 0 ? gradeDay() : false,
  })) {
    if (!step.run) { log(`${step.name} ${step.reason}`); continue }
    log(`${step.name}${step.reason}`)
    const ok = run(step.name, step.argv)
    if (ok) markRan(step.name)
    note(ok, ok ? `${step.name}を作った` : `★${step.name}に失敗`)
    // ★商品がまだ作れていないなら、このあとの記事づくりへは進ませない（2026-11-14）。
    if (!ok) productsPending = true
  }
}

// ---------- 4.5 昨日の結果と採点（night が死ぬ前提で拾う）----------
// ★2026-10-30に追加。night.sh（05:00）だけの仕事だったが毎朝死んでいる。
//   実際に10/29の公式結果が入っていなかった。実績＝商品の根拠なので止めない。
{
  const p2b = (n) => String(n).padStart(2, '0')
  const y = new Date(now.getTime() - 24 * 3600e3)
  const YEST = `${y.getFullYear()}-${p2b(y.getMonth() + 1)}-${p2b(y.getDate())}`
  const racesLatest = (() => { try { return db.prepare('SELECT MAX(date) d FROM races').get()?.d ?? null } catch { return null } })()
  const plan = decideResults({ racesLatest, yesterday: YEST, done: state.done ?? [] })
  log(`昨日の結果 ${plan.reason}`)
  if (plan.run && !heavyRunning()) {
    let ok = true
    for (const argv of plan.argv) {
      // ★採点（--fill）は1本落ちても他を続ける。取り込み（daily）が落ちたら後ろは無意味なので止める。
      const r = run(argv[0].replace('scripts/', '').replace('.mjs', ''), argv, 4096)
      if (!r && argv[0].includes('daily.mjs')) { ok = false; break }
    }
    if (ok) markRan('昨日の結果')
    note(ok, ok ? '昨日の結果を取り込んだ' : '★昨日の結果の取り込みに失敗')
  } else if (plan.run) { log('  （重い処理が走っているので次の回にまわします）'); deferred.push('昨日の結果（重い処理が走っています）') }
}

// ---------- 5. 記事と有料の文面（morning が死ぬ前提で作り直す）----------
// ★2026-10-29に追加。これらは morning.sh の中にあり、morning は毎朝死んでいる。
//   10/23〜10/28はニュース記事が5日間止まり、有料の文面も空のままだった。
//   10/28に見張りへ足したが**復旧を足し忘れた**ので、翌朝また止まった。
if (hasPredict()) {
  // ⚠ プレビュー記事（auto-preview-…）は**未来の日付**を名前に持つ（2026-10-29に踏んだ）。
  //   そのまま最大値を取ると「最新 2026-11-05」になり、今日のぶんが有るのに
  //   毎回「ありません」と判定して生成し続ける。未来日と preview を外す。
  const newsLatest = (() => {
    try {
      const days = readdirSync(join(ROOT, 'content', 'news'))
        .filter((n) => n.endsWith('.md') && !n.includes('preview'))
        .map((n) => (/(\d{4}-\d{2}-\d{2})/.exec(n) ?? [])[1])
        .filter((d) => d && d <= TODAY).sort()
      return days[days.length - 1] ?? null
    } catch { return null }
  })()
  const postFile = join(ROOT, 'logs', `morning-post-${TODAY}.txt`)
  const postBytes = (() => { try { return existsSync(postFile) ? statSync(postFile).size : 0 } catch { return 0 } })()
  const venueAgeDays = (() => {
    try {
      const dir = join(ROOT, 'content', 'venues')
      let newest = 0
      for (const n of readdirSync(dir)) if (n.endsWith('.md')) newest = Math.max(newest, statSync(join(dir, n)).mtimeMs)
      return newest ? (Date.now() - newest) / 86400000 : 99
    } catch { return 99 }
  })()

  for (const step of decideContent({
    hasPredict: true, newsLatest, postBytes, venueAgeDays, done: state.done ?? [], date: TODAY,
    productsPending, hm: HHMM,
  })) {
    if (!step.run) { log(`${step.name} ${step.reason}`); continue }
    log(`${step.name}${step.reason}`)
    let ok
    if (step.argv[0] === '__morning_post__') {
      // ★有料の文面は3本の出力をまとめて1つのファイルにする（morning.sh と同じ形）。
      //   tenkai=展開解説／x-post=X投稿／picks --paid=有料の買い目。
      ok = runToFile(postFile, [
        ['scripts/tenkai.mjs', '--date', TODAY],
        ['scripts/x-post.mjs', '--date', TODAY],
        ['scripts/picks.mjs', '--paid', '--date', TODAY],
      ], 4096)
    } else ok = run(step.name, step.argv, 4096)
    if (ok) markRan(step.name)
    note(ok, ok ? `${step.name}を作った` : `★${step.name}に失敗`)
  }
}
db.close()

// ---------- 記録と知らせ ----------
const all = [...did, ...failed]
if (all.length) {
  log('やったこと: ' + all.join(' / '))
  if (!DRY) {
    try {
      mkdirSync(join(ROOT, 'logs'), { recursive: true })
      appendFileSync(join(ROOT, 'logs', `ensure-${TODAY}.log`), `${HHMM}  ${all.join(' / ')}\n`, 'utf8')
    } catch { /* 書けなくても続ける */ }
    try {
      // ★notifyBuy ではなく notifyOps を使うこと。あちらは買い目の記録に追記する。
      const { notifyOps } = await import('./notify.mjs')
      await notifyOps(all.join('\n'),
        failed.length ? `★直せませんでした（${HHMM}）` : `自動で直しました（${HHMM}）`)
    } catch (e) { log('知らせに失敗:', String(e.message).slice(0, 80)) }
  }
} else if (deferred.length) {
  log('先送りしました: ' + deferred.join(' / '))
  log('まだ揃っていません。次の回でやり直します')
} else log('すべて揃っています。何もしませんでした')
// ★先送りも「成功」ではない。復旧がこれを見て、もう一度呼びにくる。
if (failed.length || deferred.length) process.exitCode = 1
