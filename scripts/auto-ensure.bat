@echo off
rem Make sure today's deliverables exist; rebuild only what is missing.
rem Runs every 30 minutes between 06:30 and 22:30.
rem
rem Why this exists (2026-10-20): on 10/18, 10/19 and 10/20 the nightly batch
rem died part-way and the day's picks (haishin / tansho / b2 / spot) were never
rem written. kesson.mjs correctly raised the alarm each time, but nothing acted
rem on it -- a human had to re-run the steps by hand. This is the part that acts.
rem
rem Races lost to a passed deadline are NOT recoverable (haishin/tansho/spot
rem refuse to record them), so running often and early is the whole point.
rem
rem The steps live in scripts/ensure-day.sh because the sleep guard
rem (keepawake-run.ps1) can only be handed a .sh path.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\ensure-run-!TODAY!.log
echo ==== !TIME! ensure start ==== >> "!LOG!"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/ensure-day.sh" >> "!LOG!" 2>&1
echo ==== !TIME! ensure done (exit !ERRORLEVEL!) ==== >> "!LOG!"
endlocal
