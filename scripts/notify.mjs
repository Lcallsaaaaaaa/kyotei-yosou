// 買い目が出たことを知らせる。LINE・Discord・Windows通知に対応。
//
//   node scripts/notify.mjs --test            設定を確認してテスト送信
//
// ★なぜLINE Notifyを使わないか
//   LINE Notify は2025年3月31日でサービス終了。公式の後継は Messaging API。
//   参考: https://developers.line.biz/ja/docs/messaging-api/
//
// ★なぜブラウザ操作でLINEに送らないか
//   個人アカウントの自動操作はLINEの利用規約で禁止されている。
//   加えてセッション切れ・2段階認証・UI変更で頻繁に壊れる。
//   「締切10分前に届く」という時間に依存する仕組みを、壊れやすい土台に乗せない。
//
// ★LINEは使わない（2026-08-22 判断）
//   本人の希望で見送り。data/notify.json を置かなければLINE送信は動かない。
//   通知経路は Windows通知＋ビープ＋logs/buy-日付.txt＋スマホ用ページ(status.mjs)。
//   コードは残してあるが、設定ファイルが無い限り一切送信しない。
//
// ★設定ファイル data/notify.json（現在は未使用）
//   {
//     "line":    { "token": "チャネルアクセストークン", "to": "自分のuserId" },
//     "discord": { "webhook": "https://discord.com/api/webhooks/..." }
//   }
//   要らないものは書かなければ動かない。ファイルが無ければWindows通知だけになる。
//   **このファイルは共有しないこと。**トークンはLINE公式アカウントを操作できる鍵。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function config() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'notify.json'), 'utf8')) } catch { return {} }
}

/** LINE公式アカウントから自分あてにプッシュ送信する */
async function line(cfg, text) {
  if (!cfg?.token || !cfg?.to) return null
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ to: cfg.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return `LINE失敗 ${r.status} ${(await r.text()).slice(0, 200)}`
  return 'LINE送信'
}

async function discord(cfg, text) {
  if (!cfg?.webhook) return null
  const r = await fetch(cfg.webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900) }), signal: AbortSignal.timeout(15_000),
  })
  return r.ok ? 'Discord送信' : `Discord失敗 ${r.status}`
}

/** テレグラムのBotから自分あてに送る（2026-10-09 追加）
 *  ★LINEより向いている理由
 *    ・公式アカウントも審査も要らない。@BotFather で作るだけ
 *    ・トークンに期限が無い（LINEのチャネルアクセストークンは失効する）
 *    ・無料。通数の上限も実質無い
 *  ★設定（data/notify.json）
 *    { "telegram": { "token": "123456:ABC-DEF...", "chat_id": "123456789" } }
 *    chat_id は node scripts/notify.mjs --telegram-id で調べられる。 */
async function telegram(cfg, text) {
  if (!cfg?.token || !cfg?.chat_id) return null
  const r = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // 4096文字が上限。記号で壊れないよう書式指定は付けない（parse_mode なし）
    body: JSON.stringify({ chat_id: cfg.chat_id, text: text.slice(0, 4000),
      disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return `テレグラム失敗 ${r.status} ${(await r.text()).slice(0, 200)}`
  return 'テレグラム送信'
}

/** Windowsの通知バルーン。別プロセスで出すのでブロックしない */
function toast(title, text) {
  const esc = (s) => s.replace(/'/g, "''").replace(/\r?\n/g, ' ')
  const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
    + '$n=New-Object System.Windows.Forms.NotifyIcon;'
    + '$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;'
    + `$n.ShowBalloonTip(20000,'${esc(title)}','${esc(text)}',[System.Windows.Forms.ToolTipIcon]::Info);`
    + 'Start-Sleep -Seconds 12;$n.Dispose()'
  // ★spawn の失敗は try/catch では捕まらない（'error' イベントで後から飛んでくる）。
  //   受け手が無いと Node が落ちる。2026-09-27、タスクスケジューラから走らせた
  //   欠品の見張りが powershell を PATH に見つけられず、通知どころか
  //   **見張りそのものが落ちた**。知らせられないことより、落ちるほうが害が大きい。
  //   PATH に無いことがあるので、Windows の絶対パスも順に試す。
  const cands = [process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null,
  'powershell.exe', 'powershell'].filter(Boolean)
  const run = (i) => {
    if (i >= cands.length) return
    try {
      const p = spawn(cands[i], ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore' })
      p.on('error', () => run(i + 1))   // これが無いと落ちる
      p.unref()
    } catch { run(i + 1) }
  }
  run(0)
}

/** 買い目を知らせる。届いた経路を配列で返す */
export async function notifyBuy(text, title = '買い目が出ました') {
  const cfg = config()
  process.stdout.write('\x07')                 // ビープ
  toast(title, text)
  const sent = ['Windows通知']
  // ★1つ失敗しても他は送る。全部 await して結果をまとめる
  for (const r of await Promise.allSettled([line(cfg.line, text), discord(cfg.discord, text), telegram(cfg.telegram, text)]))
    if (r.status === 'fulfilled' && r.value) sent.push(r.value)
    else if (r.status === 'rejected') sent.push(`失敗: ${String(r.reason).slice(0, 80)}`)
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true })
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    appendFileSync(join(ROOT, 'logs', `buy-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.txt`),
      `${d.toTimeString().slice(0, 5)}  ${text.replace(/\n/g, ' / ')}\n`)
  } catch {}
  return sent
}

/**
 * 仕組みの不具合・自動修理を知らせる（買い目ではない）。
 *
 * ★なぜ notifyBuy と分けるか（2026-10-20）
 *   notifyBuy は **logs/buy-日付.txt＝買い目の記録**に追記する。
 *   直す係（ensure-day.mjs）の「配信を作り直した」をそこへ混ぜると、
 *   あとで買い記録を読み返したときに何を買ったのか分からなくなる。
 *   経路（LINE/Discord/Telegram/Windows通知）は同じものを使い、記録先だけ変える。
 */
export async function notifyOps(text, title = 'お知らせ') {
  const cfg = config()
  toast(title, text)
  const sent = ['Windows通知']
  for (const r of await Promise.allSettled([line(cfg.line, text), discord(cfg.discord, text), telegram(cfg.telegram, text)]))
    if (r.status === 'fulfilled' && r.value) sent.push(r.value)
    else if (r.status === 'rejected') sent.push(`失敗: ${String(r.reason).slice(0, 80)}`)
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true })
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    appendFileSync(join(ROOT, 'logs', `ops-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.txt`),
      `${d.toTimeString().slice(0, 5)}  ${title}  ${text.replace(/\n/g, ' / ')}\n`)
  } catch { /* 記録できなくても通知は送れている */ }
  return sent
}

// ---------- テレグラムの chat_id を調べる ----------
// ★手順
//   1. テレグラムで @BotFather を開く → /newbot → 名前を決める → トークンが出る
//   2. data/notify.json にトークンだけ書く（chat_id は空でよい）
//        { "telegram": { "token": "123456:ABC-DEF...", "chat_id": "" } }
//   3. **作ったBotとのトークを開いて、何か1通送る**（「あ」でよい）
//      ← これをやらないと chat_id は分からない。Botから先には話しかけられない決まり
//   4. node scripts/notify.mjs --telegram-id
if (process.argv.includes('--telegram-id')) {
  const cfg = config()
  const token = cfg.telegram?.token
  if (!token) {
    console.error('data/notify.json に telegram.token がありません。')
    console.error('  @BotFather で /newbot してトークンを取り、こう書いてください：')
    console.error('  { "telegram": { "token": "123456:ABC-DEF...", "chat_id": "" } }')
    process.exit(1)
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`,
    { signal: AbortSignal.timeout(15_000) })
  const j = await r.json().catch(() => null)
  if (!j?.ok) {
    console.error('テレグラムに繋がりません:', JSON.stringify(j).slice(0, 300))
    console.error('トークンが違うかもしれません。')
    process.exit(1)
  }
  const ids = new Map()
  for (const u of j.result ?? []) {
    const c = u.message?.chat ?? u.channel_post?.chat
    if (c?.id) ids.set(c.id, [c.first_name, c.username, c.title].filter(Boolean).join(' / ') || '(名前なし)')
  }
  if (!ids.size) {
    console.log('まだ見つかりません。')
    console.log('**作ったBotとのトークを開いて、何か1通送ってから**もう一度実行してください。')
    console.log('（Botから先に話しかけることはできない決まりです）')
    process.exit(0)
  }
  console.log('見つかりました：')
  for (const [id, who] of ids) console.log(`  chat_id = ${id}   （${who}）`)
  console.log('')
  console.log('これを data/notify.json の telegram.chat_id に書いてください。')
  console.log('そのあと： node scripts/notify.mjs --test')
  process.exit(0)
}

// ---------- 動作確認 ----------
if (process.argv.includes('--test')) {
  const cfg = config()
  console.log('設定:', {
    line: cfg.line?.token ? `token ${cfg.line.token.slice(0, 8)}… / to ${cfg.line.to?.slice(0, 8)}…` : '未設定',
    discord: cfg.discord?.webhook ? '設定あり' : '未設定',
    telegram: cfg.telegram?.token ? `token ${cfg.telegram.token.slice(0, 10)}… / chat_id ${cfg.telegram.chat_id}` : '未設定',
  })
  const r = await notifyBuy('【動作確認】競艇の買い目通知テストです。\n実際の買い目ではありません。', '通知テスト')
  console.log('結果:', r.join(' / '))
  if (!cfg.line?.token) {
    console.log('')
    console.log('スマホに飛ばすには data/notify.json を作ってください。')
    console.log('')
    console.log('■ テレグラムを勧めます（公式アカウントも審査も要らない・トークンに期限が無い・無料）')
    console.log(JSON.stringify({ telegram: { token: '123456:ABC-DEF...', chat_id: '123456789' } }, null, 2))
    console.log('  1. テレグラムで @BotFather →  /newbot  → トークンが出る')
    console.log('  2. 上のtokenだけ書く（chat_idは空でよい）')
    console.log('  3. 作ったBotとのトークに何か1通送る（「あ」でよい）')
    console.log('  4. node scripts/notify.mjs --telegram-id   → chat_id が出る')
    console.log('')
    console.log('■ ほかの経路（どれでも・併用可）')
    console.log(JSON.stringify({
      discord: { webhook: 'https://discord.com/api/webhooks/...' },
      line: { token: 'チャネルアクセストークン', to: '自分のuserId' },
    }, null, 2))
  }
}
