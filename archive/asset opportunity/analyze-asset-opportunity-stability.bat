@echo off
setlocal

echo === Asset Opportunity decision-rule stability - pick a basis, report, repick ===

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

:ask_basis
set "BASIS_CHOICE="
set "BASIS="
set /p "BASIS_CHOICE=Forward horizon basis to test [1=pair, 2=base_only (BASE long), 3=quote_only (QUOTE short), Enter/Q=quit]: "
if not defined BASIS_CHOICE exit /b 0
if /i "%BASIS_CHOICE%"=="Q" exit /b 0
if "%BASIS_CHOICE%"=="1" set "BASIS=pair"
if "%BASIS_CHOICE%"=="2" set "BASIS=base_only"
if "%BASIS_CHOICE%"=="3" set "BASIS=quote_only"
if not defined BASIS (
    echo Please enter 1, 2, 3, or Q.
    goto ask_basis
)

rem New archive rows carry all three bases from one sweep; --basis re-bases the
rem stability test. Legacy single-basis rows count only when their stored basis
rem matches. The horizon falls back to the smallest horizon in the archive.
rem Pass extra arguments (e.g. --batch-run-id is not supported here; see the
rem script header) after the fixed flags below.
set "OUTPUT_PREFIX=%ARCHIVE_DIR%\stability-analysis-%BASIS%"
cls
echo Basis: %BASIS%
echo Analyzing archive, please wait...
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-stability.ts" --archive-dir "%ARCHIVE_DIR%" --output-prefix "%OUTPUT_PREFIX%" --basis "%BASIS%" --top-k 1,2,3 --non-overlapping --seed 42 %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
    echo.
    echo Reports were written to:
    echo   "%OUTPUT_PREFIX%.txt"
    echo   "%OUTPUT_PREFIX%.json"
) else (
    echo.
    echo Analyzer exited with code %EXIT_CODE%.
)

echo.
goto ask_basis
