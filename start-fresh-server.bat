@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

for /f %%i in ('git rev-parse --short HEAD') do set GIT_COMMIT=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content 'price-data\ibkr\csv\4h\SPY.csv' -Tail 1) -split ',' | Select-Object -First 1"`) do set FINDER_DATA_SYNC_SNAPSHOT=%%i

rem Load server-side secrets from the repository .env exactly like
rem run_playground.bat does - the Alpaca fetcher reads them via process.env
rem (Vite's own .env loader only exposes VITE_-prefixed client vars).
set "ALPACA_API_KEY="
set "ALPACA_API_SECRET="
set "LOCAL_PROXY_TOKEN="
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0.env") do (
        set "_line=%%a"
        if not "!_line:~0,1!"=="#" (
            if /i "%%a"=="ALPACA_API_KEY" set "ALPACA_API_KEY=%%b"
            if /i "%%a"=="ALPACA_API_SECRET" set "ALPACA_API_SECRET=%%b"
            if /i "%%a"=="LOCAL_PROXY_TOKEN" set "LOCAL_PROXY_TOKEN=%%b"
        )
    )
)

echo GIT_COMMIT=%GIT_COMMIT%
echo FINDER_DATA_SYNC_SNAPSHOT=%FINDER_DATA_SYNC_SNAPSHOT%
if defined ALPACA_API_KEY (echo ALPACA_API_KEY=loaded) else (echo ALPACA_API_KEY=MISSING - price sync will fail!)
if defined ALPACA_API_SECRET (echo ALPACA_API_SECRET=loaded) else (echo ALPACA_API_SECRET=MISSING - price sync will fail!)
echo Starting dev server (heap 16GB). Close this window to stop it.

set NODE_OPTIONS=--max-old-space-size=16384
call npm run dev
pause
