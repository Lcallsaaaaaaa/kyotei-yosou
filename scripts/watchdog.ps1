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

# ★見張りを二重に走らせない（2026-10-31）。
#   13:43、予定実行ぶんと手で走らせたぶんが重なり、odds-live が2本立った。
#   常駐が2本になると同じレースを二重に書き、どちらが正しいか分からなくなる
#   （10/24 にも同じことをやった）。
#   タスク側の IgnoreNew は「予定実行どうし」しか防げないので、ここで鍵を持つ。
$lock = Join-Path $root 'data\watchdog.lock'
if (Test-Path $lock) {
  $lpid = @(Get-Content $lock -ErrorAction SilentlyContinue)[0]
  $lage = ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes
  $lalive = $false
  if ($lpid) { $lalive = $null -ne (Get-Process -Id $lpid -ErrorAction SilentlyContinue) }
  if ($lalive -and $lage -lt 10) {
    "$(Get-Date -Format 'HH:mm:ss') 別の見張り（PID $lpid）が動いているので何もしない" | Add-Content $wlog -Encoding utf8
    exit 0
  }
}
Set-Content -Path $lock -Value $PID -Encoding ascii

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { "$(Get-Date -Format 'HH:mm:ss') node.exe not found" | Add-Content $wlog -Encoding utf8; exit 1 }

# ★沈黙を測り、戻ったら自分で監査と作り直しを始める（2026-11-09）。
#   この見張りは10分おきに動く。だから「前回いつ動いたか」を残しておけば、
#   機械が止まっていた時間がそのまま分かる。
#
#   なぜ要るか：11/08 と 11/09、機械が早朝から昼前まで6時間沈黙した。
#   06:00 の morning も 06:30〜11:00 の ensure（30分毎に10回）も1回も動かず、
#   起きたときには当日の番組表すら無かった。番組表が無いと予想も配信も作れない。
#   04:00 の kesson は気づいていたが、送り先が無く**ファイルに書いて終わり**だった。
#
#   ⚠ この機械は S0 低電力アイドル（モダンスタンバイ）。沈黙そのものは防げない。
#     ここでやるのは「戻った直後に最短で立て直す」こと。
#     次の定期実行（最大30分後）を待たないぶんだけ早い。
$pulse = Join-Path $logs 'hb-watchdog.txt'
$gap = 0
if (Test-Path $pulse) { $gap = ((Get-Date) - (Get-Item $pulse).LastWriteTime).TotalMinutes }
# 最初の1回（記録が無い）は沈黙と見なさない。印だけ作る。
$firstRun = -not (Test-Path $pulse)
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Set-Content $pulse -Encoding ascii

# 10分おきなので、25分を超えていたら「動いていなかった」とみなす。
#   ⚠ 短くしすぎないこと。見張り自身が重い回（CIM＋ポート確認）で
#     数分ずれることがあり、毎回「沈黙」と誤判定して復旧を回し続ける。
if (-not $firstRun -and $gap -gt 25) {
  "$(Get-Date -Format 'HH:mm:ss') 沈黙 $([int]$gap) 分を検知。監査と作り直しを始めます" |
    Add-Content $wlog -Encoding utf8
  $rlog = Join-Path $logs ("recover-run-$today-" + (Get-Date -Format 'HHmmss') + ".log")
  try {
    # ★待たない。見張りの上限は10分、復旧は最大50分かかる。
    #   ここで待つと見張りが時間切れで殺され、常駐の立て直しが止まる。
    Start-Process -FilePath $node -ArgumentList @('scripts\recover.mjs', '--gap', [int]$gap) `
      -WorkingDirectory $root -WindowStyle Hidden `
      -RedirectStandardOutput $rlog -RedirectStandardError ($rlog -replace '\.log$', '-err.log')
    "$(Get-Date -Format 'HH:mm:ss') 復旧を起動 -> $(Split-Path $rlog -Leaf)" | Add-Content $wlog -Encoding utf8
  } catch {
    "$(Get-Date -Format 'HH:mm:ss') 復旧を起動できませんでした: $_" | Add-Content $wlog -Encoding utf8
  }
}


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
  # 2026-09-27: pushes today's data to R2 every 3 min. Without it the public site
  # is frozen at the 6am batch all day: no pre-race info, no odds, no results.
  # It was written long ago but never started and never watched.
  #
  # ▶ 2026-11-13: RESUMED BY THE OWNER (paused 10-31). The public site is on hold; only the daily
  #   picks (haishin / tansho / b2 / spot) and the LAN page on :3940 keep running.
  #   Reason: 8GB of RAM cannot carry the publisher and the picks at the same time.
  #   The full pass was taking 55+ minutes and never completing, so the site sat at
  #   03:29 while every resident was paged out to 0MB.
  #   TO RESUME: delete the two '#' below, and re-enable the boatrace-publish task
  #     Enable-ScheduledTask -TaskName 'boatrace-publish'
  @{ name = 'sync-live'; match = 'sync-public\.mjs.*--live'; log = "sync-live-$today.log"
  args = @('scripts\sync-public.mjs', '--live') }
)

# ★生きていても何もしていない常駐を立て直す（2026-09-27）。
#   プロセスの有無だけでは「固まったまま生きている」を拾えない。
#   sync-live は1周ごとに data/sync-public-state.json を書くので、
#   その更新時刻を鼓動として見る。20分以上止まっていたら殺す。
#   （下の foreach が、プロセスが居なくなったのを見て立て直す）
#
# ★時間帯の限定をやめた（2026-11-13）。
#   以前は 08:30〜21:30 だけ見ていた（「レースのある時間帯」という理由）。
#   ところが publish は 00:00 に走り、sync-live も夜どおし動いている。
#   11/13 02:34 に立ち上がった sync-live が 02:56 で止まり、
#   **52分のあいだ誰も気づかなかった**（気づく仕掛けが夜は寝ていた）。
#   そのせいで有料会員の翌月ぶんの箱が作られないままだった。
#   見張りは24時間動くのだから、見る対象も24時間でいい。
$hm = Get-Date -Format 'HH:mm'
if ($true) {
  $beat = Join-Path $root 'data\sync-public-state.json'
  if (Test-Path $beat) {
    $age = ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalMinutes
    if ($age -gt 20) {
      $stuck = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'sync-public\.mjs.*--live' })
      foreach ($p in $stuck) {
        # ★立て直した直後は殺さない（2026-10-05）
        #   最初の1周は丸ごと送り直すので10分以上かかる。その間ファイルは古いままなので、
        #   鼓動の古さだけで判断すると**立ち上がっては殺されるだけ**になる。
        #   10/05はこれで13:41〜15:13に10回繰り返し、サイトが2時間止まった。
        #   プロセス自身の年齢を見て、1周ぶんの猶予（25分）を与える。
        $aliveMin = ((Get-Date) - $p.CreationDate).TotalMinutes
        if ($aliveMin -lt 25) {
          "$(Get-Date -Format 'HH:mm:ss') sync-live は立ち上げて $([int]$aliveMin) 分なので待つ（鼓動は $([int]$age) 分前）" |
            Add-Content $wlog -Encoding utf8
          continue
        }
        try {
          Stop-Process -Id $p.ProcessId -Force
          # ★消えるのを待つ。待たずに一覧を取り直すと「まだ居る」と見え、立て直しが次の回（10分後）になる。
          Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
          "$(Get-Date -Format 'HH:mm:ss') killed stuck sync-live (PID $($p.ProcessId), no beat for $([int]$age) min, alive $([int]$aliveMin) min)" |
            Add-Content $wlog -Encoding utf8
        } catch {
          "$(Get-Date -Format 'HH:mm:ss') FAILED to kill sync-live: $_" | Add-Content $wlog -Encoding utf8
        }
      }
      # 殺した直後の一覧は古いので取り直す
      $cmdlines = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine })
    }
  }
}

# ★手元の画面が「生きているのに答えない」を拾う（2026-10-05）。
#   status.mjs は日に1回ほど静かに死ぬ。プロセスが消えるぶんは下の foreach が
#   立て直すが、**居るのに応答しない**壊れ方は誰も捕まえられなかった。
#   ポートを叩いて、答えなければ殺す（下の foreach が立て直す）。
#   ⚠ Invoke-WebRequest は 5.1 だと既定で IE エンジンを使い、初回に
#     「初回実行の構成」で固まることがある。-UseBasicParsing を必ず付ける。
if ($hm -ge '07:30' -and $hm -le '23:00') {
  $alive = @($cmdlines | Where-Object { $_ -match 'status.mjs' }).Count -gt 0
  if ($alive) {
    $answered = $false
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3940/haishin' -TimeoutSec 10 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $answered = $true }
    } catch { $answered = $false }
    if (-not $answered) {
      $wedged = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'status.mjs' })
      foreach ($p in $wedged) {
        try {
          Stop-Process -Id $p.ProcessId -Force
          # ★消えるのを待つ。待たずに一覧を取り直すと「まだ居る」と見え、立て直しが次の回（10分後）になる。
          Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
          "$(Get-Date -Format 'HH:mm:ss') killed wedged status (PID $($p.ProcessId), port 3940 no answer)" |
            Add-Content $wlog -Encoding utf8
        } catch {
          "$(Get-Date -Format 'HH:mm:ss') FAILED to kill status: $_" | Add-Content $wlog -Encoding utf8
        }
      }
      $cmdlines = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine })
    }
  }
}

# ★「居るのに何もしていない」常駐を鼓動で見分ける（2026-10-31）。
#   プロセスの有無だけでは、生きたまま黙った常駐を拾えない。
#   各常駐は1周ごとに logs\hb-*.txt を書くので、その更新時刻を鼓動として見る。
#   止まっていたら落とす。下の foreach が、居なくなったのを見て立て直す。
#
#   なぜ要るか：10/31 11:45 に auto-bet が `database is locked` で落ちた。
#   プロセスが消えたので立て直せたが、**消えずに黙る**壊れ方は誰も見ていなかった
#   （status.mjs は画面に出すだけで、落としはしない）。
#
#   しきい値は「その常駐が一番長く寝る時間＋余裕」。短すぎると、正常に寝ている
#   だけの常駐を落とし続ける（10/05 に sync-live でそれをやり、2時間止めた）。
#   odds-live 20秒／auto-bet 最長180秒／before 最長30分。
$beats = @(
  @{ name = 'odds-live';   match = 'odds-live\.mjs';      file = 'logs\hb-odds-live.txt'; stale = 10; grace = 10 }
  @{ name = 'auto-bet';    match = 'auto-bet\.mjs';       file = 'logs\hb-auto-bet.txt';  stale = 12; grace = 10 }
  @{ name = 'before-live'; match = 'before\.mjs.*--live'; file = 'logs\hb-before.txt';    stale = 40; grace = 15 }
)
if ($hm -ge '08:00' -and $hm -le '21:30') {
  $killed = $false
  foreach ($b in $beats) {
    $f = Join-Path $root $b.file
    # ★鼓動ファイルが無いのは、起動直後か、鼓動を打たない古い版が動いているから。
    #   ここで落とすと「無い→落とす→また無い」で延々と落とし続ける。触らない。
    if (-not (Test-Path $f)) { continue }
    $age = ((Get-Date) - (Get-Item $f).LastWriteTime).TotalMinutes
    if ($age -le $b.stale) { continue }
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match $b.match })
    foreach ($p in $procs) {
      # ★立ち上げ直後は落とさない。最初の1周は時間がかかる。
      $aliveMin = ((Get-Date) - $p.CreationDate).TotalMinutes
      if ($aliveMin -lt $b.grace) {
        "$(Get-Date -Format 'HH:mm:ss') $($b.name) は立ち上げて $([int]$aliveMin) 分なので待つ（鼓動は $([int]$age) 分前）" |
          Add-Content $wlog -Encoding utf8
        continue
      }
      try {
        Stop-Process -Id $p.ProcessId -Force
        # ★消えるのを待つ。待たずに一覧を取り直すと「まだ居る」と見え、立て直しが次の回（10分後）になる。
        Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        $killed = $true
        "$(Get-Date -Format 'HH:mm:ss') 黙った $($b.name) を落とした（PID $($p.ProcessId)・鼓動 $([int]$age) 分前・稼働 $([int]$aliveMin) 分）" |
          Add-Content $wlog -Encoding utf8
      } catch {
        "$(Get-Date -Format 'HH:mm:ss') $($b.name) を落とせなかった: $_" | Add-Content $wlog -Encoding utf8
      }
    }
  }
  # 落とした直後の一覧は古いので取り直す
  if ($killed) { $cmdlines = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine }) }
}

# ★-RedirectStandardOutput は追記ではなく「上書き」する。
#   2026-08-23 に auto-bet が死んで再起動した際、朝からの記録が全部消えて
#   死んだ原因を追えなくなった。再起動ごとに別ファイルへ書き、後で結合する。
# ★常駐が2本以上に増えていたら、古い1本だけ残す（2026-10-31）。
#   二重だと同じレースを二重に書く。原因が何であれ、ここで必ず1本に戻す。
foreach ($w in $workers) {
  $dup = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $w.match } | Sort-Object CreationDate)
  if ($dup.Count -le 1) { continue }
  foreach ($d in $dup[1..($dup.Count - 1)]) {
    try {
      Stop-Process -Id $d.ProcessId -Force
      # ★消えるのを待つ。待たずに一覧を取り直すと「まだ居る」と見え、立て直しが次の回（10分後）になる。
      Wait-Process -Id $d.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
      "$(Get-Date -Format 'HH:mm:ss') $($w.name) が $($dup.Count) 本あったので余分な PID $($d.ProcessId) を落とした" |
        Add-Content $wlog -Encoding utf8
    } catch {
      "$(Get-Date -Format 'HH:mm:ss') 余分な $($w.name) を落とせなかった: $_" | Add-Content $wlog -Encoding utf8
    }
  }
  $cmdlines = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine })
}

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



# ★何時間も居座った重い処理を片付ける（2026-11-12）。
#   11/12 01:36、当日の番組表を作ろうとした build.mjs が
#   `database is locked` で 0ファイル処理に終わった。原因は
#   **2時間前から居座っていた別の build.mjs** がDBの書き込みロックを
#   掴んだままだったこと（WALも00:24から更新されていなかった）。
#   番組表が無いと予想も配信も作れず、odds-live は10分おきに
#   「番組表がありません」で落ち続ける（11/11は36回再起動した）。
#
#   常駐は鼓動で見ているが、重い処理は一度きりなので鼓動が無く、
#   **固まっても誰も気づけなかった**。時間で切る。
#   ⚠ しきい値は「正常に長い」より十分上に。derive は実測40分、
#     publish のデータ書き出しは80分。だから120分。
#
#   ★2026-11-17：一覧から **predict.mjs が漏れていた**。
#     00:29に始まった predict が 07:39 時点で **7時間12分・実メモリ0MB** で居座り、
#     heavy.mjs がそれを「重い処理が走っている」と見るので、
#     ensure-day の予想づくりが朝じゅう「次の回にまわします」で進まなかった。
#     掃除の対象は heavy.mjs が見る顔ぶれと合わせること。片方だけ直すと食い違う。
$stuckMin = 120
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'build\.mjs|derive\.mjs|addbefore\.mjs|daily\.mjs|model5\.mjs|racefeat\.mjs|predict\.mjs|grade\.mjs|patterns\.mjs|catchup-today' })) {
  $aliveMin = ((Get-Date) - $p.CreationDate).TotalMinutes
  if ($aliveMin -lt $stuckMin) { continue }
  $name = ($p.CommandLine -replace '.*scripts.','')
  if ($name.Length -gt 40) { $name = $name.Substring(0, 40) }
  try {
    Stop-Process -Id $p.ProcessId -Force
    Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    "$(Get-Date -Format 'HH:mm:ss') 固まった重い処理を落とした（$name・PID $($p.ProcessId)・$([int]$aliveMin)分）" |
      Add-Content $wlog -Encoding utf8
  } catch {
    "$(Get-Date -Format 'HH:mm:ss') 固まった重い処理を落とせなかった（$name）: $_" | Add-Content $wlog -Encoding utf8
  }
}

# ★常駐の優先度を上げる（2026-11-11）。
#   この機械は搭載7.8GBで、Claude Code・Chrome・ChatGPT だけでコミット12GB超。
#   11/11 の実測で ページング 37,184回/秒、空き0.7GB、
#   **常駐16本の実メモリ合計がわずか139MB**まで追い出されていた。
#   その結果、機械は起動したままなのに競艇の処理だけが何時間も進まない
#   （11/11は 01:42〜09:23 の461分、11/08は 01:04〜11:11 の607分）。
#   タスクは起動しても .bat の1行目のログにすら届かずに殺される。
#
#   メモリは増やせないので、せめて**奪い合いに勝てるようにする**。
#   締切前オッズはその瞬間にしか取れず、逃すと永久に欠ける。
#   ⚠ High にはしない。OS の応答を奪ってかえって不安定になる。AboveNormal まで。
foreach ($w in $workers) {
  foreach ($p in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
    try {
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
      if ($cl -notmatch $w.match) { continue }
      if ($p.PriorityClass -ne 'AboveNormal') {
        $p.PriorityClass = 'AboveNormal'
        "$(Get-Date -Format 'HH:mm:ss') $($w.name) の優先度を上げた（PID $($p.Id)）" | Add-Content $wlog -Encoding utf8
      }
    } catch { }
  }
}

# 鍵を外す。途中で落ちた場合は、次回が「10分＋PID不在」で古い鍵と判断する。
try { Remove-Item $lock -Force -ErrorAction SilentlyContinue } catch { }
