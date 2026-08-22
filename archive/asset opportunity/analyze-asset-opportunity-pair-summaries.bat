@echo off
setlocal

for %%I in ("%~dp0.") do set "ARCHIVE_DIR=%%~fI"
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
set "ESNO=%REPO_ROOT%\..\..\..\node_modules\.bin\esno.cmd"

if not exist "%ESNO%" (
    where esno.cmd >nul 2>&1
    if errorlevel 1 (
        echo Could not find esno. Run npm install from the lightweight-charts repository first.
        exit /b 1
    )
    set "ESNO=esno.cmd"
)

set "OUTPUT_PREFIX=%ARCHIVE_DIR%\pair-summary-analysis"
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-pair-summaries.ts" --archive-dir "%ARCHIVE_DIR%" --stride-bars 12 --horizon 12 --output-prefix "%OUTPUT_PREFIX%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
    echo.
    echo Reports were written to:
    echo   "%OUTPUT_PREFIX%.txt"
    echo   "%OUTPUT_PREFIX%.json"
)

echo.
pause
exit /b %EXIT_CODE%
