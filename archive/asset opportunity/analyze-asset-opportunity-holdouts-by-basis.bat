@echo off
setlocal

echo === Asset Opportunity holdout analysis - pick a basis, report, repick ===

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
set /p "BASIS_CHOICE=Forward horizon basis to report [1=pair, 2=base_only (BASE long), 3=quote_only (QUOTE short), Enter/Q=quit]: "
if not defined BASIS_CHOICE exit /b 0
if /i "%BASIS_CHOICE%"=="Q" exit /b 0
if "%BASIS_CHOICE%"=="1" set "BASIS=pair"
if "%BASIS_CHOICE%"=="2" set "BASIS=base_only"
if "%BASIS_CHOICE%"=="3" set "BASIS=quote_only"
if not defined BASIS (
    echo Please enter 1, 2, 3, or Q.
    goto ask_basis
)

:ask_top_k
set "TOP_K="
set /p "TOP_K=Enter cumulative top-K size, no larger than Finder Top N (1 = rank 1 only; 3 = ranks 1-3 pooled): "
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

set "OUTPUT_PREFIX=%ARCHIVE_DIR%\holdout-analysis-%BASIS%-top-%TOP_K%"
rem New archive rows carry all three bases from one sweep; --basis re-bases the
rem report. Legacy single-basis rows count only when their stored basis matches.
rem Pass --batch-run-id <id> in extra arguments to restrict to one run.
rem Replace the previous report on screen: only the newest pass stays visible.
cls
echo Basis: %BASIS% - top-K: %TOP_K%
echo Analyzing archive, please wait...
call "%ESNO%" "%REPO_ROOT%\scripts\analyze-asset-opportunity-holdouts.ts" --archive-dir "%ARCHIVE_DIR%" --top-k "%TOP_K%" --basis "%BASIS%" --output-prefix "%OUTPUT_PREFIX%" %*
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
