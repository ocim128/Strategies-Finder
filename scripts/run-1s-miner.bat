@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

set "ESNO=..\..\..\node_modules\.bin\esno.cmd"
set "DB=price-data\1second-chart\second-market-data.sqlite"
set "LOG_DIR=price-data\1second-chart\logs"
set "LOG_FILE=%LOG_DIR%\run-1s-miner-latest.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [run-1s-miner] Started %DATE% %TIME% > "%LOG_FILE%"
echo Repo: %CD% >> "%LOG_FILE%"
echo ESNO: %ESNO% >> "%LOG_FILE%"
echo DB: %DB% >> "%LOG_FILE%"
echo Binance DNS: adguard-doh >> "%LOG_FILE%"
echo Args: %* >> "%LOG_FILE%"

echo 1s miner launcher
echo Repo: %CD%
echo DB: %DB%
echo Log: %CD%\%LOG_FILE%
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found on PATH.
    echo ERROR: Node.js was not found on PATH. >> "%LOG_FILE%"
    set "EXIT_CODE=1"
    goto done
)

if not exist "%ESNO%" (
    echo ERROR: Missing esno launcher: %ESNO%
    echo ERROR: Missing esno launcher: %ESNO% >> "%LOG_FILE%"
    set "EXIT_CODE=1"
    goto done
)

call "%ESNO%" scripts\second-market-miner.ts --mode live --symbols "BTCUSDT,XRPUSDT" --outcome-intervals "5m,15m" --db "%DB%" --binance-dns adguard-doh %*
set "EXIT_CODE=%ERRORLEVEL%"

:done
echo.
echo Miner exited with code %EXIT_CODE%.
echo Miner exited with code %EXIT_CODE%. >> "%LOG_FILE%"
echo Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%
