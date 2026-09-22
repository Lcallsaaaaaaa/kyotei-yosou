# 当日の結果を取って、配信用の的中判定を入れる。15分ごとに走らせる。
#
# ⚠ このファイルは UTF-8 **BOM付き**・CRLF で保存すること。
#   Windows PowerShell 5.1 は BOM 無しの .ps1 を CP932 として読むので、
#   日本語コメントが化けて構文エラーになる（2026-08-23 に watchdog で実際に起きた）。
#   編集後の確認:
#     powershell -Command "[ScriptBlock]::Create((Get-Content <file> -Raw))"
#
# ⚠ このファイルを bash のヒアドキュメントで作らないこと。
#   バックスラッシュが消えて 'C:\Program Files\nodejs\node.exe' が壊れる（実際にやった）。
#
# なぜ要るか:
#   競走成績(Kファイル)は翌日にならないと出ない。それ待ちだと当日は
#   「当たったかどうか」が分からなかった。公式の結果ページを直接見て埋める。
#
# node.exe を直に起動する。シェルを挟むと引用符が壊れる（watchdog で2度やった）。

$root = Split-Path -Parent $PSScriptRoot
$today = Get-Date -Format 'yyyy-MM-dd'
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$log = Join-Path $logs "haishin-$today.log"

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { "$(Get-Date -Format 'HH:mm:ss') node.exe not found" | Add-Content $log -Encoding utf8; exit 1 }

Set-Location $root
# ⚠ これが無いと node の UTF-8 出力を CP932 として読んでログが文字化けする。
#   対話的に実行したときは化けず、タスクスケジューラ経由でだけ化けたので気づきにくい。
$OutputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
"--- $(Get-Date -Format 'HH:mm:ss') ---" | Add-Content $log -Encoding utf8
# 1) 公式の結果ページから着順と払戻を取る（締切を過ぎたレースだけ）
& $node 'scripts\raceresult.mjs' '--date' $today 2>&1 | Add-Content $log -Encoding utf8
# 2) 配信用の的中を埋める
#    ⚠ --date を必ず付ける。付けないと payouts 223万行・entries 134万行を全走査し、
#      15分ごとに回すと他の処理とロックを取り合って詰まる（2026-08-31に2本詰めた）。
& $node 'scripts\haishin.mjs' '--fill' '--date' $today 2>&1 | Add-Content $log -Encoding utf8
# 3) 無料枠（単勝1点）の的中を埋める。公開している画面なので当日中に埋まる必要がある。
& $node 'scripts\tansho.mjs' '--fill' '--date' $today 2>&1 | Add-Content $log -Encoding utf8
# 4) B2判定（実際に買う対象）も同じ結果で埋める
& $node 'scripts\b2.mjs' '--fill' '--date' $today 2>&1 | Add-Content $log -Encoding utf8
# 5) 企画枠（場を指定した全レース予想）。配信の実績とは別テーブル。
#    その日に企画枠が無ければ「照合するものなし」と出て終わる。
& $node 'scripts\spot.mjs' '--fill' '--date' $today 2>&1 | Add-Content $log -Encoding utf8
