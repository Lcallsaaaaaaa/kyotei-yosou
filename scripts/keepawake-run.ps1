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
try {
  Set-Location (Split-Path -Parent $PSScriptRoot)
  & 'C:\Program Files\Git\bin\bash.exe' -c "bash $Script"
} finally {
  # 抑止を解除する。これを忘れるとPCが寝なくなる。
  [void]$api::SetThreadExecutionState($ES_CONTINUOUS)
  "$(Get-Date -Format 'HH:mm:ss') スリープ抑止を解除"
}
