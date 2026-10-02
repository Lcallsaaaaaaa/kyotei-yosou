@echo off
rem Every 5 min, 08:00-21:30: re-predict races whose exhibition is out and whose
rem deadline has not passed, using the full model (226 features), and swap the
rem numbers into data/predict-<date>.json so the site shows them.
rem   See scripts/chokuzen.mjs for what is protected and why.
rem ASCII only: cmd.exe reads this file as Shift-JIS.
rem Do NOT build the redirect path with cygpath -- the project path contains
rem Japanese and it is mangled on the way through cmd.exe, which makes bash
rem refuse to run the command at all (that is how auto-xpost.bat was broken
rem every single morning until 2026-09-27). Keep the path relative.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/chokuzen.mjs >> logs/chokuzen-!TODAY!.log 2>&1"
if not exist "logs\chokuzen-!TODAY!.log" echo %DATE% %TIME% chokuzen log was not created >> "logs\chokuzen-broken.log"
endlocal
