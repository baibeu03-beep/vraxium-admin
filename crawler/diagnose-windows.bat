@echo off
chcp 65001 >nul
REM Cafe crawler box diagnostic launcher (double-click). Secrets are never printed by the ps1.
echo [launcher] diagnose-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-windows.ps1" %*
echo.
pause
