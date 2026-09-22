@echo off
rem Race-development preview for the day, at 08:00.
rem Prefers graded races (SG/G1/G2/G3); falls back to morning/day/night picks.
rem Needs the 06:30 prep to have run (program files + model).
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/tenkai.mjs > logs/tenkai-!TODAY!.log 2>&1"
endlocal
