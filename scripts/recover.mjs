// 沈黙から戻ったときに、監査して、足りないものを作り直す。
//
//   node scripts/recover.mjs --gap 370     見張りが測った沈黙（分）を渡して実行
//   node scripts/recover.mjs --gap 370 --dry   何をするかだけ出す
//   node scripts/recover.mjs --force       沈黙に関係なく一式やる（手で叩くとき）
//
// ★なぜ要るか（2026-11-09）
//   11/08 と 11/09、機械が早朝から昼前まで6時間まるごと沈黙した。
//   その間 06:00 の morning も、06:30〜11:00 の ensure（30分毎に10回）も
//   1回も動いていない。起きたときには当日の番組表すら無く、
//   番組表が無い → 予想が作れない → 配信も無料枠も作れない、と全部倒れていた。
//   オッズ記録と買い目判定は「番組表がありません」で落ち、見張りが10分おきに
//   立て直しては落ちる、を夜通し繰り返していた。
//
//   04:00 の kesson は「当日の予想ファイルがありません」と正しく気づいていた。
//   ところが送り先（data/notify.json）が無く、**ファイルに書いて終わり**だった。
//
//   だから「気づいて知らせる」ではなく、**気づいて自分で作り直す**ところまでやる。
//   起きた直後に動くので、次の定期実行（最大30分後）を待たない。
//
// ★この機械は S0 低電力アイドル（モダンスタンバイ）。
//   その状態に入ると裏の処理は止まり、スリープの記録も残らない。
//   沈黙そのものは、この仕組みでは防げない。戻ったあとを最短にするだけ。
//   締切を過ぎたレースは haishin/tansho/spot が記録を拒むので、
//   沈黙している間に過ぎた締切ぶんは取り返せない。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setPriority } from 'node:os'

// ★自分の優先度を上げる（2026-11-11）。
//   予定タスクから起動されたものは **BelowNormal** で動く。
//   Task Scheduler の既定の優先度は 7（BELOW_NORMAL）で、子プロセスも引き継ぐ。
//   競艇のタスクは全部これで、`<Priority>` を一度も指定していなかった。
//   搭載7.8GB・ページング47,000回/秒 のこの機械では、BelowNormal の処理は
//   いつまでも進まない。11/11 は作り直しが **6時間15分** 走って時間切れになった。
//   -7 は Windows で ABOVE_NORMAL。ここで上げると、この後 execFileSync で
//   呼ぶ derive・predict などの子も同じ優先度を引き継ぐ。
//   ⚠ High にはしない。OSの応答を奪ってかえって不安定になる。
try { setPriority(-7) } catch { /* 上げられなくても続ける */ }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOGS = join(ROOT, 'logs')
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FORCE = argv.includes('--force')
const GAP = (() => { const i = argv.indexOf('--gap'); return i > -1 ? Number(argv[i + 1]) : 0 })()

// ★日付は必ず +9時間して作る。素の toISOString は UTC なので
//   00:00〜09:00 の間だけ前日になる（check.mjs の罠が見張っている）。
const jst = () => new Date(Date.now() + 9 * 3600e3)
const today = () => jst().toISOString().slice(0, 10)
const hm = () => jst().toISOString().slice(11, 16)

mkdirSync(LOGS, { recursive: true })
const LOG = join(LOGS, `recover-${today()}.log`)
const OPS = join(LOGS, `ops-${today()}.txt`)
const log = (s) => {
  const line = `${hm()} ${s}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* 書けなくても続ける */ }
}

// ★二重に走らせない。ensure-day 自体にも鍵はあるが、監査→生成→再監査を
//   二重に回すと kesson の記録が混ざって読めなくなる。
const LOCK = join(ROOT, 'data', 'recover.lock')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
if (!DRY && existsSync(LOCK)) {
  let pid = null, age = 999
  try {
    const j = JSON.parse(readFileSync(LOCK, 'utf8').replace(/^﻿/, ''))
    pid = j.pid; age = (Date.now() - j.at) / 60000
  } catch { /* 壊れていても年齢で判断する */ }
  if (pid && alive(pid) && age < 40) {
    log(`別の復旧が動いています（PID ${pid}・${Math.round(age)}分前）。何もしません`)
    process.exit(0)
  }
  if (pid && alive(pid)) {
    log(`前の復旧（PID ${pid}）が ${Math.round(age)}分 固まっているので片付けます`)
    try { process.kill(pid) } catch { /* すでに居ない */ }
  }
}
// ★鍵は「始めた時刻」ではなく「最後に進んだ時刻」を持つ（2026-11-11）。
//   始めた時刻で40分と見ると、工程が正直に長引いただけで次の回に殺される。
//   逆に上限を延ばすと、本当に固まったときの放置が長くなる。
//   工程ごとに押し直せば、「40分なにも進んでいない＝固まった」で正しく判定できる。
const touchLock = () => {
  if (DRY) return
  try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch { /* 書けなくても進む */ }
}
touchLock()
const unlock = () => { try { unlinkSync(LOCK) } catch { /* 無ければそれでいい */ } }
process.on('exit', unlock)

// ---------- 走らせる ----------
// ★出力は必ず持ち帰る。捨てると「失敗したのに成功に見える」が起きる
//   （keepawake-run.ps1 で8日間それをやった）。
// ★readOnly の工程（監査）は --dry でも本当に走らせる。
//   飛ばすと「欠品なし」と出てしまい、--dry が何の役にも立たない。
function run(label, args, minutes, readOnly = false) {
  if (DRY && !readOnly) { log(`  → ${label}（--dry なので実行しません）`); return { ok: true, out: '' } }
  const t0 = Date.now()
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: minutes * 60_000, maxBuffer: 32 * 1024 * 1024,
    })
    log(`  ✓ ${label}（${Math.round((Date.now() - t0) / 1000)}秒）`)
    touchLock()
    return { ok: true, out }
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    log(`  ✗ ${label}: ${String(e.message).slice(0, 120)}`)
    touchLock()
    return { ok: false, out }
  }
}

// kesson.mjs が「✗」を付けた行だけ拾う（記録に残すため）
function missingOf(out) {
  return out.split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('✗'))
    .map((l) => l.replace(/^✗\s*/, ''))
    .filter((l, i, a) => a.indexOf(l) === i)
}
// ★前後を比べるときは**項目名だけ**で見る（2026-11-09）。
//   kesson の行には「13460分前」「100時間前」のように毎回変わる数字が入る。
//   行まるごとで比べると、何も直っていないのに文字列が違うだけで
//   「埋まった」と数えてしまう。実際に最初の試験でそれをやった。
const keyOf = (line) => line.split('　')[0].trim()

// ★成否の判断は kesson ではなく ensure-day に聞く（2026-11-09）。
//   kesson は「静的HTML」「サイトの更新」も欠品に数えるが、サイトの公開は
//   10/31に本人の指示で止めてある。kesson を判断に使うと、**直しようのない項目を
//   永久に追いかけて10分おきに作り直しを回し続ける**。
//   ensure-day は自分が責任を持つものだけを見る。そこが唯一の判断の場所。
function ensureSaysComplete() {
  const r = run('持ち物の確認（ensure-day --dry）', ['scripts/ensure-day.mjs', '--dry'], 20, true)
  return { done: /すべて揃っています/.test(r.out), out: r.out }
}

const reason = FORCE ? '手動' : `沈黙 ${Math.round(GAP)}分`
log(`=== 復旧（${reason}）===`)

// ① 監査：いま何が足りないか（全体像を記録に残す）
const before = run('監査（kesson）', ['scripts/kesson.mjs'], 20, true)
const miss0 = missingOf(before.out)
if (miss0.length) for (const m of miss0) log(`    ✗ ${m}`)
// ★監査そのものが失敗したら「欠品なし」と言わない（2026-11-11）。
//   11/11 01:56、機械が詰まって kesson が10分で時間切れになり、
//   出力が空だったので**「欠品なし」と記録した**。実際は予想ファイルすら無かった。
//   出せない答えを、良いほうに丸めてはいけない。
else if (!before.ok) log('    監査できませんでした（中身は不明）')
else log('    欠品なし')

// ② 作り直す必要があるか（止めてあるサイトは数えない）
const chk0 = ensureSaysComplete()
if (chk0.done && !FORCE) {
  log('作れるものは揃っています。作り直しは行いません')
  if (miss0.length) log(`（kesson の欠品 ${miss0.length}件 は止めてあるサイトなど、ここでは直せないものです）`)
  process.exit(0)
}

// ③ 生成：足りないものを作る。ensure-day が「何が要るか」を知っている唯一の場所。
//    ⚠ ここで ensure-day を迂回して個別スクリプトを並べないこと。
//      判断が2か所に分かれ、片方だけ直して食い違う（10/22の事故）。
const made = run('作り直し（ensure-day）', ['scripts/ensure-day.mjs'], 50)
// ★鍵で弾かれたのを「やった」と数えない（2026-11-09）。
//   ensure-day は別の実行が動いていると何もせず終了コード0で帰る。
//   それを成功として扱うと、1件も作っていないのに成功と記録される。
const blocked = /別の ensure-day が動いています/.test(made.out)
if (blocked) log('  （別の作り直しが動いていたので、今回は何もしていません）')

// ④ 再監査：本当に埋まったかを確かめる。
//    ★「直した」と言う前に必ず通す。動かさずに報告しない。
const after = run('再監査（kesson）', ['scripts/kesson.mjs'], 20, true)
const miss1 = missingOf(after.out)
const keys1 = new Set(miss1.map(keyOf))
const fixed = blocked ? [] : miss0.filter((m) => !keys1.has(keyOf(m)))
const chk1 = DRY ? chk0 : ensureSaysComplete()

log(`埋まった ${fixed.length}件`)
for (const m of fixed) log(`    ✓ ${keyOf(m)}`)
for (const m of miss1) log(`    残: ${m}`)

// 画面（status.mjs の「朝の見張り表」）から見えるところにも1行残す
const verdict = blocked ? '別の作り直し中' : chk1.done ? '作れるものは揃いました' : 'まだ足りません'
try {
  appendFileSync(OPS, `${hm()}  復旧（${reason}）  埋まった${fixed.length}件・${verdict}\n`)
} catch { /* 書けなくても結果は変わらない */ }

if (blocked || !chk1.done) {
  log('★ まだ足りません。次の見張り（10分後）でもう一度試します')
  process.exit(1)
}
log('復旧できました（作れるものは揃っています）')
