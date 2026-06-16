@echo off
chcp 65001 >nul
REM Naver session seed launcher (double-click). A browser window opens for manual login.
echo [launcher] seed-naver-session-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0seed-naver-session-windows.ps1" %*
echo.
pause
