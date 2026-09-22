@echo off
rem Settle yesterday's judged bets, then build the result X post.
rem Runs after auto-catchup (15:00), which imports the K files, the odds
rem and the deadlines. Everything below therefore needs no network.
rem
rem Order matters:
rem   1. paper-day    record the FULL-DAY judgment for yesterday (all races,
rem                   pre-deadline odds only, deadline order, daily cap).
rem                   Needs races.deadline, which auto-catchup just imported.
rem   2. results      settle what was actually bought (bets)
rem   3. paper-report score the full-day judgment against the payouts
rem   4. bt-build     rebuild the backtest table so scripts/backtest.mjs stays current
rem   5. x-post       build the result post
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"') do set YDAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/paper-day.mjs --date !YDAY! > logs/paper-!YDAY!.txt 2>&1; node scripts/results.mjs > logs/results-!TODAY!.txt 2>&1 && node scripts/paper-report.mjs --date !YDAY! >> logs/results-!TODAY!.txt 2>&1 && node --max-old-space-size=8192 scripts/bt-build.mjs > logs/bt-!TODAY!.txt 2>&1; node scripts/x-post.mjs --result >> logs/results-!TODAY!.txt 2>&1"
endlocal
