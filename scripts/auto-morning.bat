@echo off
rem Daily prep + predict all races at 06:00, then start the all-day workers.
rem Yesterday collection is a separate 05:00 task (auto-night.bat).
rem
rem Keep the PC awake while morning.sh runs (added 2026-10-15).
rem   The task option "Wake the computer to run" only WAKES the machine; it does
rem   not stop it from going back to sleep DURING the run. On 2026-10-15 the
rem   machine slept mid-run: this task died with 3221225786 (forced exit) and
rem   morning-2026-10-15.log was 0 bytes. The predictions had been written at
rem   08:03, but morning.sh never reached news.mjs / venue-article.mjs at the
rem   end of the file, so NO article was produced that day and /news stopped
rem   updating. night2.bat already had this guard; it was never copied here.
rem   The guard covers morning.sh only -- the "start" lines below are detached
rem   and return immediately.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\morning-!TODAY!.log
echo ==== !TODAY! !TIME! start ==== >> "!LOG!"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/morning.sh" >> "!LOG!" 2>&1
echo ==== prep done !TIME! (exit !ERRORLEVEL!) ==== >> "!LOG!"

rem Kill yesterday's workers so ports and DB handles are free.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'odds-live|auto-bet|status\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

rem 1) pre-deadline odds recorder: STOPPED 2026-08-29 by request.
rem    It polled the official site all day just to record odds we do not judge on.
rem    auto-bet fetches odds itself at judgment time and stores them in bets.odds_seen,
rem    so the drift check (bet-time odds vs final odds) still accumulates from normal use.
rem    Table odds_live is kept for past analysis.
rem    To resume: node scripts/odds-live.mjs --date YYYY-MM-DD

rem 2) judge buy/skip between 12 and 2 minutes before each candidate race
start "auto-bet" /min "C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node --max-old-space-size=4096 scripts/auto-bet.mjs --date !TODAY! >> logs/bet-!TODAY!.log 2>&1"

rem 3) phone-friendly status page on http://<LAN-IP>:3940
start "status" /min "C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/status.mjs >> logs/status-!TODAY!.log 2>&1"
endlocal
