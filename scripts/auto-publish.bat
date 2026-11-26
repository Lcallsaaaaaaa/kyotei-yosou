@echo off
rem Rebuild the static HTML and deploy it. Runs at 23:40 every day.
rem
rem Why this exists (2026-10-11):
rem   news.mjs and venue-article.mjs write new articles every morning, and the
rem   resident sync-public --live pushes them to R2. But prerender + deploy were
rem   only ever run by hand. The SPA reads R2 so people saw fresh pages, while the
rem   HTML that search engines and SNS crawlers read stayed at the last manual
rem   deploy. Articles written for SEO never reached the crawlers.
rem
rem   publish-static.mjs refuses to run during race hours by itself (heavy-guard),
rem   so a late race night simply skips this run. The next night catches up.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=logs\publish-!TODAY!.log
echo ==== !TODAY! !TIME! publish start ==== >> "!LOG!"
rem Keep the PC awake: the three steps take about 10 minutes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake-run.ps1" -Script "scripts/publish.sh" >> "!LOG!" 2>&1
echo ==== !TIME! publish done (exit !ERRORLEVEL!) ==== >> "!LOG!"
endlocal
