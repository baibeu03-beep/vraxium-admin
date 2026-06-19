@echo off
chcp 65001 >nul
REM Cafe crawler autostart installer. MUST run as Administrator.
REM Right-click this .bat -> "Run as administrator". Secrets are never printed by the ps1.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [launcher] 관리자 권한이 필요합니다. 이 파일을 우클릭 -^> "관리자 권한으로 실행" 하세요.
  echo.
  pause
  exit /b 1
)
echo [launcher] install-autostart-windows.ps1 (admin)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart-windows.ps1" %*
echo.
pause
