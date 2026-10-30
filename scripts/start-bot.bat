@echo off
rem Starts the bot and restarts it if it crashes. Arguments are passed on, e.g.:
rem   scripts\start-bot.bat --server friend1
cd /d "%~dp0\.."
:loop
node index.js %*
if %ERRORLEVEL% EQU 0 goto end
echo Bot stopped unexpectedly (exit code %ERRORLEVEL%). Restarting in 15 seconds... (close this window to stop)
timeout /t 15 /nobreak >nul
goto loop
:end
