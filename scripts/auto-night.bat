@echo off
rem Collect and analyse yesterday's races. Runs at 05:00 every day.
rem
rem Keep the PC awake while it runs (added 2026-10-15).
rem   The task option "Wake the computer to run" only WAKES the machine; it does
rem   not stop it from going back to sleep DURING the run. On 2026-10-15 the
rem   machine slept mid-run and the 05:00, 06:00 and 15:30 tasks all died
rem   (results 267014 / 3221225786). No news article was written that day.
rem   night2.bat already did this; the pattern was never copied to the others.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\night-!TODAY!.log
echo ==== !TODAY! !TIME! night start ==== >> "!LOG!"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/night.sh" >> "!LOG!" 2>&1
echo ==== !TODAY! !TIME! night done (exit !ERRORLEVEL!) ==== >> "!LOG!"
endlocal
