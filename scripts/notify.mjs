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

/** Windowsの通知バルーン。別プロセスで出すのでブロックしない */
function toast(title, text) {
  const esc = (s) => s.replace(/'/g, "''").replace(/\r?\n/g, ' ')
  const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
    + '$n=New-Object System.Windows.Forms.NotifyIcon;'
    + '$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;'
    + `$n.ShowBalloonTip(20000,'${esc(title)}','${esc(text)}',[System.Windows.Forms.ToolTipIcon]::Info);`
    + 'Start-Sleep -Seconds 12;$n.Dispose()'
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
      { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

/** 買い目を知らせる。届いた経路を配列で返す */
export async function notifyBuy(text, title = '買い目が出ました') {
  const cfg = config()
  process.stdout.write('\x07')                 // ビープ
  toast(title, text)
  const sent = ['Windows通知']
  // ★1つ失敗しても他は送る。全部 await して結果をまとめる
  for (const r of await Promise.allSettled([line(cfg.line, text), discord(cfg.discord, text)]))
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

// ---------- 動作確認 ----------
if (process.argv.includes('--test')) {
  const cfg = config()
  console.log('設定:', {
    line: cfg.line?.token ? `token ${cfg.line.token.slice(0, 8)}… / to ${cfg.line.to?.slice(0, 8)}…` : '未設定',
    discord: cfg.discord?.webhook ? '設定あり' : '未設定',
  })
  const r = await notifyBuy('【動作確認】競艇の買い目通知テストです。\n実際の買い目ではありません。', '通知テスト')
  console.log('結果:', r.join(' / '))
  if (!cfg.line?.token) {
    console.log(`\nLINEに送るには data/notify.json を作ってください：`)
    console.log(JSON.stringify({ line: { token: 'チャネルアクセストークン', to: '自分のuserId' } }, null, 2))
  }
}
