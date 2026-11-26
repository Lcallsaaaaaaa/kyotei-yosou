@echo off
rem Record today's pre-deadline state, every 30 min from 07:00.
rem
rem   1. winprob-daily  per-boat win probabilities (for the odds research)
rem   2. patterns       the five bet-type patterns that members see
rem   3. patterns-settle fill in hit/payout as results come in
rem
rem Why a task of its own: data/predict-<date>.json is rewritten all day by
rem auto-bet (strategy.mjs runPredict has a 20-minute cache), and the last
rem write lands AFTER the final race. Features are rebuilt from that day's
rem results in between, so a probability read late is partly made after the
rem fact. We therefore copy the value early and never overwrite it.
rem
rem All three skip races whose deadline has passed and never rewrite a row
rem that already has a result, so running this repeatedly is safe.
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
"C:\Program Files\Git\bin\bash.exe" -lc "cd \"$(cygpath -u '%CD%')\" && export PATH='/c/Program Files/nodejs:$PATH' && node scripts/winprob-daily.mjs >> logs/winprob-!TODAY!.log 2>&1; node scripts/patterns.mjs >> logs/patterns-!TODAY!.log 2>&1; node scripts/patterns-settle.mjs >> logs/patterns-!TODAY!.log 2>&1"
endlocal
