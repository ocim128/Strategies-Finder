@echo off
setlocal
echo Cleaning up existing processes on port 5173...
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
    echo Killing process PID: %%i
    taskkill /f /pid %%i >nul 2>&1
)
echo Starting Lightweight Charts Playground...
call npx vite
pause
