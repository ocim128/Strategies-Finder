@echo off
setlocal
cd /d "%~dp0"

for /f %%i in ('git rev-parse --short HEAD') do set GIT_COMMIT=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content 'price-data\ibkr\csv\4h\SPY.csv' -Tail 1) -split ',' | Select-Object -First 1"`) do set FINDER_DATA_SYNC_SNAPSHOT=%%i

echo GIT_COMMIT=%GIT_COMMIT%
echo FINDER_DATA_SYNC_SNAPSHOT=%FINDER_DATA_SYNC_SNAPSHOT%
echo Starting dev server (heap 16GB). Close this window to stop it.

set NODE_OPTIONS=--max-old-space-size=16384
call npm run dev
pause
