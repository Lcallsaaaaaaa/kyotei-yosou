@echo off
rem 07:00 morning bundle. One predict run is shared via data/predict-<date>.json,
rem so the three outputs cost ~5 min total instead of ~15.
rem   1) tenkai.mjs  : featured races (morning/noon/night) with race development
rem   2) x-post.mjs  : free 3renpuku picks for X
rem   3) picks.mjs   : paid tansho candidate list
rem ASCII only: cmd.exe reads this file as Shift-JIS.
rem 2026-09-27 FIX: the output was redirected to "$(cygpath -u '%CD%')/logs/...".
rem   The project path contains Japanese, which is mangled on the way through
rem   cmd.exe, so bash could not open the file -- and bash refuses to run the
rem   command at all when it cannot open the redirect. All three jobs above had
rem   been silently skipped every morning. Redirect to a relative path instead,
rem   the same way auto-tenkai.bat does (bash has already cd'd to the root).
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && { node --max-old-space-size=6144 scripts/tenkai.mjs --date !TODAY!; node --max-old-space-size=6144 scripts/x-post.mjs --date !TODAY!; node --max-old-space-size=6144 scripts/picks.mjs --paid --date !TODAY!; } > logs/morning-post-!TODAY!.txt 2>&1"
if not exist "logs\morning-post-!TODAY!.txt" echo %DATE% %TIME% morning-post log was not created >> "logs\xpost-broken.log"
endlocal
