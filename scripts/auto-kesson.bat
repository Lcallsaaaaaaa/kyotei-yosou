@echo off
rem Every 30 min: check that today's outputs actually exist.
rem   See scripts/kesson.mjs for what is checked and why.
rem ASCII only: cmd.exe reads this file as Shift-JIS.
rem Do NOT build the redirect path with cygpath -- the project path contains
rem Japanese and it is mangled on the way through cmd.exe, which makes bash
rem refuse to run the command at all (that is how auto-xpost.bat was broken
rem every single morning until 2026-09-27). Keep the path relative.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/kesson.mjs >> logs/kesson-run-!TODAY!.log 2>&1"
endlocal
