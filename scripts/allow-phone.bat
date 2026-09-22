@echo off
rem Allow the phone to open the status page over the LAN.
rem RIGHT-CLICK this file and choose "Run as administrator".
rem ASCII only: cmd.exe reads this file as Shift-JIS and breaks on UTF-8 Japanese.

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [NG] Administrator rights are required.
  echo        Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo.
echo === 1/2  Mark the Wi-Fi as a Private network ===
rem A "Public" network blocks incoming connections, so the phone cannot reach the PC.
powershell -NoProfile -Command "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private; Write-Output ('  changed: ' + $_.Name) }"

echo.
echo === 2/2  Open TCP port 3940 for the status page ===
powershell -NoProfile -Command "Remove-NetFirewallRule -DisplayName 'boatrace-status-3940' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'boatrace-status-3940' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3940 -Profile Private,Domain | Out-Null; Write-Output '  rule created'"

echo.
echo === Result ===
powershell -NoProfile -Command "Get-NetConnectionProfile | Select-Object Name,NetworkCategory | Format-Table -AutoSize"
powershell -NoProfile -Command "$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' }).IPAddress; foreach($i in $ips){ Write-Output ('  Open on your phone:  http://' + $i + ':3940/asa') }"

echo.
echo   Done. Open the URL above on a phone connected to the same Wi-Fi.
echo.
pause
