@echo off
rem Collect and analyse yesterday's races. Runs at 05:00 every day.
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
echo ==== !TODAY! !TIME! night start ==== >> "logs\night-!TODAY!.log"
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && bash scripts/night.sh" >> "logs\night-!TODAY!.log" 2>&1
echo ==== !TODAY! !TIME! night done ==== >> "logs\night-!TODAY!.log"
endlocal
