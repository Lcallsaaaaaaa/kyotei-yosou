@echo off
rem Retrain the model if today's retrain has not happened yet.
rem Runs every 30 minutes between 03:30 and 09:00.
rem
rem Why this exists (2026-10-20): the retrain used to be step 9/9 at the end of
rem night2.sh. When night2 died somewhere in steps 1-8 it never reached step 9,
rem so the retrain was skipped entirely. That happened on 10/18, 10/19 and
rem 10/20 -- the production model sat at 10/17 and nobody noticed. The last step
rem of the longest job is the easiest place to lose work, so it moved out.
rem
rem scripts/retrain-needed.mjs decides whether to run (exit 0 = run), so calling
rem this every 30 minutes costs nothing when the work is already done. It also
rem refuses to start while a heavy job (derive / addbefore / predict / model5)
rem is running -- on a 7.8GB machine two of those together kill each other.
rem
rem The steps live in scripts/ensure-retrain.sh because the sleep guard
rem (keepawake-run.ps1) can only be handed a .sh path. The retrain takes about
rem 10 minutes, so being put to sleep mid-run is a real risk.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\retrain-!TODAY!.log
echo ==== !TIME! retrain check ==== >> "!LOG!"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/ensure-retrain.sh" >> "!LOG!" 2>&1
echo ==== !TIME! retrain done (exit !ERRORLEVEL!) ==== >> "!LOG!"
endlocal
