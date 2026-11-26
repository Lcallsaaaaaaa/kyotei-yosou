@echo off
rem Hold off sleep while races are running, so the batches are not cut in half.
rem Runs every 30 minutes.
rem
rem Why this wrapper exists (2026-10-24): the task used to call powershell.exe
rem directly and returned 2147946720 (0x80070520) / 3221225786 after a reboot,
rem so the sleep guard was not running at all. Tasks that go through a .bat kept
rem returning 0 through the same reboot.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0keepawake-day.ps1"
endlocal
exit /b %ERRORLEVEL%
