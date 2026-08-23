@echo off
setlocal

for %%I in ("%~dp0..\..\..") do set "REPO_ROOT=%%~fI"
set "ARCHIVE_DIR=%REPO_ROOT%\archive\fresh-window"
set "ESNO=%REPO_ROOT%\..\..\..\node_modules\.bin\esno.cmd"

if not exist "%ESNO%" (
    where esno.cmd >nul 2>&1
    if errorlevel 1 (
        echo Could not find esno. Run npm install from the lightweight-charts repository first.
        exit /b 1
    )
    set "ESNO=esno.cmd"
)

call "%ESNO%" "%REPO_ROOT%\scripts\analyze-fresh-window-research.ts" --archive-dir "%ARCHIVE_DIR%" --stride-bars 12 --horizon 12 --seed 42 %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Fresh-window archive: "%ARCHIVE_DIR%"
exit /b %EXIT_CODE%
