@echo off
rem 07:00 morning bundle. One predict run is shared via data/predict-<date>.json,
rem so the three outputs cost ~5 min total instead of ~15.
rem   1) tenkai.mjs  : featured races (morning/noon/night) with race development
rem   2) x-post.mjs  : free 3renpuku picks for X
rem   3) picks.mjs   : paid tansho candidate list
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set L=logs\morning-post-!TODAY!.txt
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && { node --max-old-space-size=6144 scripts/tenkai.mjs --date !TODAY!; node --max-old-space-size=6144 scripts/x-post.mjs --date !TODAY!; node --max-old-space-size=6144 scripts/picks.mjs --paid --date !TODAY!; } > \"$(cygpath -u '%CD%')/logs/morning-post-!TODAY!.txt\" 2>&1"
endlocal
