@echo off
REM process-check-worker service wrapper - Task Scheduler ONSTART (SYSTEM), boot autostart.
REM Auto-restarts on crash (loop) and logs to file. Calls WORKER_BASE_URL (Vercel admin).
setlocal
cd /d "%~dp0\..\.."
set "LOGDIR=C:\ProgramData\vraxium\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\worker.log"
:loop
echo [%date% %time%] starting process-check-worker>> "%LOG%"
node scripts\process-check-worker.mjs >> "%LOG%" 2>&1
echo [%date% %time%] worker exited code %errorlevel% restarting in 10s>> "%LOG%"
ping -n 11 127.0.0.1 >nul
goto loop
