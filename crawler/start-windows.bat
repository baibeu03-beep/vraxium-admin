@echo off
chcp 65001 >nul
REM Cafe crawler start launcher (double-click). Secrets are never printed by the ps1.
echo [launcher] start-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
echo.
pause
