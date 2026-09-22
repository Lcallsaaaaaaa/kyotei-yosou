@echo off
rem Re-import yesterday's results at 15:00 (K files publish next midday).
rem ASCII ONLY: cmd.exe reads this file as Shift-JIS. A Japanese path written
rem here gets mangled and every later command silently fails -- that is exactly
rem what happened until 2026-08-23 (catchup never ran, log named "!TODAY!.log").
rem Derive the POSIX path from %CD% with cygpath instead of hard-coding it.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
echo ==== !TODAY! !TIME! catchup start ==== >> "logs\catchup-!TODAY!.log"
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && bash scripts/catchup.sh" >> "logs\catchup-!TODAY!.log" 2>&1
echo ==== done !TIME! ==== >> "logs\catchup-!TODAY!.log"
endlocal
