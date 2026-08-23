@echo off
setlocal
cd /d "%~dp0"

set "ROLE=%~1"
if "%ROLE%"=="" set ROLE=collection

echo Running fresh-window batch (role: %ROLE%) against http://127.0.0.1:5173
echo Make sure start-fresh-server.bat is running first.
echo.

call ..\..\..\node_modules\.bin\esno.cmd scripts\fresh-window-batch-request.ts ^
  --config "archive\fresh-window-config.json" ^
  --csv "price-data\ibkr\csv\4h\SPY.csv" ^
  --role %ROLE%

echo.
echo Judge with the analyzer:
..\..\..\node_modules\.bin\esno.cmd scripts\analyze-fresh-window-research.ts --archive-dir "archive\fresh-window" --stride-bars 12 --horizon 12 --seed 42
echo.
pause
