@echo off
REM cafe-crawler service wrapper - Task Scheduler ONSTART (SYSTEM), boot autostart.
REM Auto-restarts on crash (loop) and logs to file. Server = crawler/server.ts on :8787.
setlocal
cd /d "%~dp0\..\.."
set "LOGDIR=C:\ProgramData\vraxium\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\crawler.log"
:loop
echo [%date% %time%] starting cafe-crawler server.ts port 8787>> "%LOG%"
node node_modules\tsx\dist\cli.mjs --env-file=.env.local crawler\server.ts >> "%LOG%" 2>&1
echo [%date% %time%] cafe-crawler exited code %errorlevel% restarting in 5s>> "%LOG%"
ping -n 6 127.0.0.1 >nul
goto loop
