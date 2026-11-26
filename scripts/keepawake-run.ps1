param([string]$Script = 'scripts/night2.sh')
# バッチを走らせている間、PCを寝かせないようにする。
#
# ⚠ なぜ要るか（2026-09-12）
#   02:00のバッチが工程3/8の途中で強制終了した。タスクの結果コードは
#   3221225786（=0xC000013A 強制終了）。直前の02:39にシステムがスリープへ入っていた。
#   タスクの「起こして実行(WakeToRun)」は**起こすだけ**で、実行中に寝るのは止めない。
#   その日の無料枠・企画枠・B2がまるごと記録されなかった。
#
# ⚠ このファイルは UTF-8 **BOM付き**・CRLF で保存すること。
#   Windows PowerShell 5.1 は BOM 無しの .ps1 を CP932 として読むので日本語が壊れる。
#
# ⚠ このファイルを bash のヒアドキュメントで作らないこと。
#   バックスラッシュが消えて 'C:\Program Files\Git\bin\bash.exe' が壊れる
#   （2026-09-12に実際にやった。'C:Program FilesGitinash.exe' になった）。
#
# ⚠ bash には日本語を含むパスを引数で渡さないこと。
#   PowerShell 5.1 はネイティブ実行ファイルへの引数を CP932 で渡すので壊れる。
#   PowerShell 側で作業フォルダへ移動し、bash には相対パスだけ渡す。
$OutputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);'
$api = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
[void]$api::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))
"$(Get-Date -Format 'HH:mm:ss') スリープ抑止を開始"
# ★優先度を上げる（2026-11-11に発覚）。
#   予定タスクから起動されたものは **BelowNormal** で動く。Task Scheduler の
#   既定の優先度は 7（BELOW_NORMAL）で、bash も node もそれを引き継ぐ。
#   競艇のタスクは全部これで、`<Priority>` を一度も指定していなかった。
#   搭載7.8GB・ページング47,000回/秒 のこの機械では BelowNormal の処理は進まず、
#   11/11 は作り直しが6時間15分走って時間切れ、11/08・11/11 とも
#   機械は起動したままログが6〜10時間途切れた。
#   ここで上げれば bash とその子（node 全部）に効く＝night・morning・ensure・
#   retrain・publish すべてが対象。
#   ⚠ High にはしない。OSの応答を奪ってかえって不安定になる。
try {
  [Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'AboveNormal'
  "$(Get-Date -Format 'HH:mm:ss') 優先度を AboveNormal に上げた"
} catch {
  "$(Get-Date -Format 'HH:mm:ss') 優先度を上げられませんでした: $_"
}
# ⚠ bash の終了コードを必ず持ち帰ること（2026-10-30に発覚）。
#   ここで捨てていたため、中身が失敗してもタスクの結果は毎回 0（成功）になっていた。
#   publish は10/23から毎晩メモリ不足で落ちていたのに「成功」と記録され、
#   **静的HTMLとサイトマップが7日間止まっていることに誰も気づけなかった**。
#   これを使う全タスク（ensure・retrain・night・morning・publish）に効く。
$code = 0
try {
  Set-Location (Split-Path -Parent $PSScriptRoot)
  & 'C:\Program Files\Git\bin\bash.exe' -c "bash $Script"
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
} finally {
  # 抑止を解除する。これを忘れるとPCが寝なくなる。
  [void]$api::SetThreadExecutionState($ES_CONTINUOUS)
  "$(Get-Date -Format 'HH:mm:ss') スリープ抑止を解除（終了コード $code）"
}
exit $code
