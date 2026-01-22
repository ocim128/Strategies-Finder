@echo off
setlocal
echo Cleaning up existing processes...

:: Kill port 5173 (Vite)
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
    echo Killing Vite process PID: %%i
    taskkill /f /pid %%i >nul 2>&1
)

:: Kill port 3030 (Rust Engine)
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :3030 ^| findstr LISTENING') do (
    echo Killing Rust Engine process PID: %%i
    taskkill /f /pid %%i >nul 2>&1
)

echo Starting Rust Trading Engine...
start "Rust Trading Engine" cmd /k "cd /d "%~dp0..\..\..\trading-engine" && cargo run --release"

echo Starting Lightweight Charts Playground...
call npx vite
pause
