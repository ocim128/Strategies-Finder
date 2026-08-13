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

rem Defaults: --pool-k 10 --cost-bps 10 --horizon 12 --min-entries 5. Override by passing flags, e.g.
rem   analyze-asset-opportunity-rotation.bat --pool-k 5 --cost-bps 7
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-rotation.ts" --archive-dir "%ARCHIVE_DIR%" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Leader-following rotation analysis complete (printed above).
echo.

echo.
pause
exit /b %EXIT_CODE%
