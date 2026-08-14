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

:ask_pool_k
set "POOL_K="
set /p "POOL_K=Enter top rank / rotation pool depth (for example, 3 or 10): "
if not defined POOL_K (
    echo Please enter a positive whole number.
    goto ask_pool_k
)
for /f "delims=0123456789" %%A in ("%POOL_K%") do (
    echo Please enter a positive whole number.
    goto ask_pool_k
)
set "NON_ZERO=%POOL_K:0=%"
if not defined NON_ZERO (
    echo Please enter a positive whole number.
    goto ask_pool_k
)

rem Additional command-line flags can still override cost, horizon, or minimum entries.
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-rotation.ts" --archive-dir "%ARCHIVE_DIR%" --pool-k "%POOL_K%" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Leader-following rotation analysis complete (printed above).
echo.

echo.
pause
exit /b %EXIT_CODE%
