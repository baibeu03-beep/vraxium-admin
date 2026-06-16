@echo off
chcp 65001 >nul
REM Cafe crawler health check launcher (double-click). Secret is sent only as a header, never printed.
echo [launcher] check-health-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-health-windows.ps1" %*
echo.
pause
