@echo off
rem 22:00 nightly: backfill the pre-race wind direction for the past year.
rem
rem Why: before_race.wind_dir was only added recently, so everything before
rem 2026-09-23 is empty. races.wind_dir (from the K file) covers the whole
rem history but is measured AFTER the race -- it matches the pre-race value
rem only 51% on speed and ~63% on direction, because the wind shifts between
rem the exhibition and the race. Training and serving must use the same
rem source, so the pre-race value has to be filled in for the past too.
rem
rem The task is killed by its 3.5h time limit (01:30) so it never overlaps
rem night2.sh at 02:00. before.mjs skips races that are already filled, so it
rem simply carries on the next night. Expect about 2 nights for one year.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
rem Keep the redirect path relative -- cygpath on a Japanese path is mangled
rem through cmd.exe and bash then refuses to run the command at all.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
for /f %%a in ('powershell -NoProfile -Command "(Get-Date).AddYears(-1).ToString('yyyy-MM-dd')"') do set YEARAGO=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/before.mjs --need-dir --from !YEARAGO! --to !TODAY! >> logs/winddir-!TODAY!.log 2>&1"
if not exist "logs\winddir-!TODAY!.log" echo %DATE% %TIME% winddir log was not created >> "logs\winddir-broken.log"
endlocal
