# 電源につながっている間は、24時間PCを寝かせない（2026-09-21に08:00〜21:30から拡大）。
#
# ★24時間にした理由（2026-09-21）
#   9/20 18:36にスリープ→04:53に一瞬起きて02:00の夜間バッチが始まった5秒後に再スリープ。
#   02:00・06:00の予想が両方出ず、有料のお客さんがいる日に昼まで予想が無かった。
#   WakeToRun は起こすだけで、処理中の再スリープは止めない。本人の了承で終日に広げた。
#
# ★なぜ要るか（2026-09-15）
#   スマホから確認用ページ（http://<PCのIP>:3940/）が開かないことがあった。
#   その朝だけで 06:50〜08:28 に5回スリープ（モダンスタンバイ）へ出入りしていた。
#   スリープ中はWindowsがアプリを一時停止するので、サーバが生きていてもページは開かない。
#   さらにスリープ明けにサーバが閉じられることもあった。本人の選択（A）で、
#   「電源接続中・08:00〜21:30だけスリープを抑止する」ことにした。
#
# ★やること
#   1分ごとに、時間帯と電源を見て SetThreadExecutionState を掛けたり外したりする。
#   電池駆動のときは何もしない（外す）。21:30を過ぎたら外して終わる。
#   Windowsの電源設定そのものは一切変えない（このプロセスが生きている間だけ効く）。
#   タスク boatrace-keepawake が 07:55 から30分おきに起動を試み、二重起動はしない
#   （途中で落ちても次の30分で戻る）。
#
# ⚠ このファイルは UTF-8 **BOM付き**・CRLF で保存すること（PS5.1はBOM無しをCP932で読む）。
# ⚠ bash のヒアドキュメントで作らないこと（バックスラッシュが消える）。
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$log = Join-Path $logs ("keepawake-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
function Log($m) { ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) | Add-Content -Path $log -Encoding utf8 }

$sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);'
$api = Add-Type -MemberDefinition $sig -Name PowerDay -Namespace Win32 -PassThru
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
Add-Type -AssemblyName System.Windows.Forms

$START = [TimeSpan]::Parse('08:00')
$END = [TimeSpan]::Parse('21:30')
$held = $false
Log "開始（PID $PID）"
try {
  while ($true) {
    $now = (Get-Date).TimeOfDay
    $onAC = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online'
    # 2026-09-21から24時間（電源接続中のみ）。夜間バッチ中の再スリープで予想が出なかったため。
    $log = Join-Path $logs ("keepawake-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
    $want = $onAC
    if ($want -and -not $held) {
      [void]$api::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)); $held = $true
      Log "スリープ抑止 ON（電源接続中）"
    } elseif (-not $want -and $held) {
      [void]$api::SetThreadExecutionState($ES_CONTINUOUS); $held = $false
      Log ("スリープ抑止 OFF（" + $(if ($onAC) { '時間外' } else { '電池駆動' }) + "）")
    } elseif ($want) {
      # 念のため掛け直す（効きが外れていても1分で戻る）
      [void]$api::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))
    }
    Start-Sleep -Seconds 60
  }
} finally {
  [void]$api::SetThreadExecutionState($ES_CONTINUOUS)
  Log "終了（抑止を解除）"
}
