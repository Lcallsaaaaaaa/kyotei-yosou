@echo off
rem Restart any resident worker that died, and kill ones that are alive but stuck.
rem Runs every 10 minutes.
rem
rem Why this wrapper exists (2026-10-24): the task used to call powershell.exe
rem directly and returned 2147946720 (0x80070520, "a specified logon session does
rem not exist") after a reboot, so NOTHING was restarted. The machine rebooted at
rem 10:58 and all five residents stayed dead -- the site sat frozen for hours and
rem a human had to start them by hand.
rem   Tasks that go through a .bat (boatrace-ensure, boatrace-results, ...) kept
rem   returning 0 through the same reboot, so the wrapper is the difference.
rem
rem Also fixed that day: ExecutionTimeLimit was PT72H on a task that runs every
rem 10 minutes. Combined with MultipleInstances=IgnoreNew, one hung run disabled
rem the watchdog for up to three days. Now PT10M.
rem
rem ASCII only: cmd.exe reads this file as Shift-JIS.
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0watchdog.ps1"
endlocal
exit /b %ERRORLEVEL%
