@echo off
rem Daily prep + predict all races at 06:00, then start the all-day workers.
rem Yesterday collection is a separate 05:00 task (auto-night.bat).
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
echo ==== !TODAY! !TIME! start ==== >> "logs\morning-!TODAY!.log"
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && bash scripts/morning.sh" >> "logs\morning-!TODAY!.log" 2>&1
echo ==== prep done !TIME! ==== >> "logs\morning-!TODAY!.log"

rem Kill yesterday's workers so ports and DB handles are free.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'odds-live|auto-bet|status\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

rem 1) pre-deadline odds recorder: STOPPED 2026-08-29 by request.
rem    It polled the official site all day just to record odds we do not judge on.
rem    auto-bet fetches odds itself at judgment time and stores them in bets.odds_seen,
rem    so the drift check (bet-time odds vs final odds) still accumulates from normal use.
rem    Table odds_live is kept (78,954 rows, 2026-08-21..29) for past analysis.
rem    To resume: node scripts/odds-live.mjs --date YYYY-MM-DD

rem 2) judge buy/skip between 12 and 2 minutes before each candidate race
start "auto-bet" /min "C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node --max-old-space-size=4096 scripts/auto-bet.mjs --date !TODAY! >> logs/bet-!TODAY!.log 2>&1"

rem 3) phone-friendly status page on http://<LAN-IP>:3940
start "status" /min "C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/status.mjs >> logs/status-!TODAY!.log 2>&1"
endlocal
