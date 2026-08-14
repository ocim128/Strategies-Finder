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

:ask_top_k
set "TOP_K="
set /p "TOP_K=Enter top rank to measure (for example, 3 or 10): "
if not defined TOP_K (
    echo Please enter a positive whole number.
    goto ask_top_k
)
for /f "delims=0123456789" %%A in ("%TOP_K%") do (
    echo Please enter a positive whole number.
    goto ask_top_k
)
set "NON_ZERO=%TOP_K:0=%"
if not defined NON_ZERO (
    echo Please enter a positive whole number.
    goto ask_top_k
)

set "OUTPUT_PREFIX=%ARCHIVE_DIR%\holdout-analysis-top-%TOP_K%"
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-holdouts.ts" --archive-dir "%ARCHIVE_DIR%" --top-k "%TOP_K%" --output-prefix "%OUTPUT_PREFIX%"
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
