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

call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-holdouts.ts" --archive-dir "%ARCHIVE_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
    echo.
    echo Reports were written to:
    echo   "%ARCHIVE_DIR%\holdout-analysis.txt"
    echo   "%ARCHIVE_DIR%\holdout-analysis.json"
)

echo.
pause
exit /b %EXIT_CODE%
