@echo off
rem Build TOMORROW-IS-TODAY predictions at 02:00, before the 06:00 batch.
rem
rem Why this exists:
rem   The 06:00 batch is the only thing that produces the day's picks. When the PC
rem   is asleep at 06:00 the whole day is lost (happened on 2026-09-01). The race
rem   card (B file) is published the day before, so everything except the exhibition
rem   data can be computed at 02:00. Exhibition data was measured on 2026-08-31 to
rem   change nothing (57.18% vs 57.38%), so waiting for it buys nothing.
rem
rem   02:00 becomes the primary run and 06:00 becomes the fallback.
rem
rem Steps:
rem   1. download + extract + build   today's race card
rem   2. grade.mjs --apply            fill races.grade (build.mjs does not write it)
rem   3. derive + addbefore           refresh features
rem   4. predict --nobefore           no exhibition data exists at 02:00; skipping it
rem                                   saves ~5 min and ~150 requests to the site
rem   5. haishin                      the regular feed (confidence >= 0.7645)
rem   6. spot --auto                  the special feature (SG/G1/G2 only)
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\night2-!TODAY!.log
echo ==== !TODAY! !TIME! start ==== >> "!LOG!"
rem Keep the PC awake while the batch runs.
rem On 2026-09-12 the system slept at 02:39 and killed the run at step 3/8
rem (task result 3221225786). WakeToRun only wakes the PC; it does not keep it awake.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/night2.sh" >> "!LOG!" 2>&1
echo ==== done !TIME! ==== >> "!LOG!"
endlocal
