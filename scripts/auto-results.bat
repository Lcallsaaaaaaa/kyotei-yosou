@echo off
rem Settle yesterday's judged bets, then build the result X post. Runs at 15:30.
rem
rem The steps moved into scripts/results.sh on 2026-10-15, because the sleep
rem guard (keepawake-run.ps1) can only be handed a .sh path -- a compound
rem command written straight into the .bat cannot be passed to it.
rem   The task option "Wake the computer to run" only WAKES the machine; it does
rem   not stop it from going back to sleep DURING the run. On 2026-10-15 the
rem   machine slept mid-run and the 05:00, 06:00 and 15:30 tasks all died
rem   (results 267014 / 3221225786). No news article was written that day.
rem
rem The order of the steps, and why bt-build is NOT here, are documented at the
rem top of scripts/results.sh.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\results-run-!TODAY!.log
echo ==== !TODAY! !TIME! results start ==== >> "!LOG!"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/results.sh" >> "!LOG!" 2>&1
echo ==== !TIME! results done (exit !ERRORLEVEL!) ==== >> "!LOG!"
endlocal
