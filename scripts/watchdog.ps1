# Restart any of the three all-day workers that died. Runs every 30 min.
#
# CAUTION: this file must stay UTF-8 **with BOM** and CRLF.
#   Windows PowerShell 5.1 reads a BOM-less .ps1 as CP932, so UTF-8 Japanese
#   comments turn into garbage and the script fails to parse. On 2026-08-23
#   that silently disabled the watchdog. Verify after editing:
#     powershell -Command "[ScriptBlock]::Create((Get-Content <file> -Raw))"
#
# Why this exists:
#   On 2026-08-22 the bet judge sat silent for 31 minutes and nobody noticed.
#   A worker can die from an unhandled error, an OOM, or a network stall.
#   Without a watchdog, a mid-day death silently costs the rest of the day.
#
# Two bugs were hit while building this. Both are recorded so they are not repeated:
#   1. The first version was a .bat that captured a nested PowerShell command with
#      `for /f`. The quoting collapsed, every check returned empty, nothing restarted.
#   2. The second version built a Git Bash command string and passed it through
#      Start-Process -ArgumentList. The array join mangled the quoting and bash
#      exited before node ever ran (the log file was never even created).
#   => Launch node.exe directly. No shell layer, no quoting to get wrong.
#
# Windows PowerShell 5.1 note: -replace does NOT support script-block substitution
# (that is PowerShell 6+). Using it silently produces a mangled string.

$root = Split-Path -Parent $PSScriptRoot
$today = Get-Date -Format 'yyyy-MM-dd'
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$wlog = Join-Path $logs "watchdog-$today.log"

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { "$(Get-Date -Format 'HH:mm:ss') node.exe not found" | Add-Content $wlog -Encoding utf8; exit 1 }

$cmdlines = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine })

$workers = @(
  @{ name = 'odds-live'; match = 'odds-live\.mjs'; log = "live-$today.log"
     args = @('--max-old-space-size=2048', 'scripts\odds-live.mjs', '--date', $today) }
  @{ name = 'auto-bet';  match = 'auto-bet\.mjs';  log = "bet-$today.log"
     args = @('--max-old-space-size=4096', 'scripts\auto-bet.mjs', '--date', $today) }
  @{ name = 'status';    match = 'status\.mjs';    log = "status-$today.log"
     args = @('scripts\status.mjs') }
  # 2026-09-22: collects pre-race info (exhibition, tilt, parts, weather) before each deadline for the data site
  @{ name = 'before-live'; match = 'before\.mjs.*--live'; log = "before-live-$today.log"
     args = @('scripts\before.mjs', '--live') }
)

# ★-RedirectStandardOutput は追記ではなく「上書き」する。
#   2026-08-23 に auto-bet が死んで再起動した際、朝からの記録が全部消えて
#   死んだ原因を追えなくなった。再起動ごとに別ファイルへ書き、後で結合する。
foreach ($w in $workers) {
  if (@($cmdlines | Where-Object { $_ -match $w.match }).Count -gt 0) { continue }
  $stamp = Get-Date -Format 'HHmmss'
  $base = [IO.Path]::GetFileNameWithoutExtension($w.log) + "-$stamp.log"
  $out = Join-Path $logs $base
  $err = Join-Path $logs ("err-" + $base)
  try {
    Start-Process -FilePath $node -ArgumentList $w.args -WorkingDirectory $root `
      -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    "$(Get-Date -Format 'HH:mm:ss') restarted $($w.name) -> $(Split-Path $out -Leaf)" | Add-Content $wlog -Encoding utf8
  } catch {
    "$(Get-Date -Format 'HH:mm:ss') FAILED $($w.name): $_" | Add-Content $wlog -Encoding utf8
  }
}
