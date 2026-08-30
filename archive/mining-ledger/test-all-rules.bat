@echo off
setlocal enabledelayedexpansion

for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
set "ESNO=%REPO_ROOT%\..\..\..\node_modules\.bin\esno.cmd"
set "CHECKER=%REPO_ROOT%\scripts\trade-ledger-checker.ts"
set "RULES_DIR=%~dp0rules"
set "REPORTS_DIR=%~dp0reports"
set "NODE_OPTIONS=--max-old-space-size=12288"

if not exist "%ESNO%" (
    where esno.cmd >nul 2>&1
    if errorlevel 1 (
        echo Could not find esno. Run npm install from the lightweight-charts repository first.
        exit /b 1
    )
    set "ESNO=esno.cmd"
)
if not exist "%CHECKER%" (
    echo Could not find the checker: %CHECKER%
    exit /b 1
)
if not exist "%RULES_DIR%" (
    echo No rules folder found: %RULES_DIR%
    exit /b 1
)

echo ============================================================
echo  Trade ledger - test ALL rules against ONE saved ledger
echo ============================================================
echo.

set /a COUNT=0
for /d %%D in ("%~dp0*") do (
    if exist "%%D\ledger.jsonl" (
        set /a COUNT+=1
        set "DIR[!COUNT!]=%%~fD"
        echo   !COUNT!. %%~nxD
    )
)
if %COUNT%==0 (
    echo No ledger folders found ^(folders containing ledger.jsonl^).
    exit /b 1
)
echo.
:ask_folder
set "CHOICE="
set /p "CHOICE=Select the folder to process [1-%COUNT%]: "
if not defined CHOICE goto ask_folder
for /f "delims=0123456789" %%A in ("%CHOICE%") do (
    echo Please enter a number.
    goto ask_folder
)
if %CHOICE% LSS 1 goto ask_folder
if %CHOICE% GTR %COUNT% goto ask_folder
set "SELECTED=!DIR[%CHOICE%]!"
for %%I in ("%SELECTED%") do set "SELECTED_NAME=%%~nxI"
echo.
echo Selected ledger: %SELECTED_NAME%

set "INCOMPLETE_FLAG="
type "%SELECTED%\summary.json" 2>nul | findstr /C:"ledgerComplete" | findstr /C:"false" >nul
if not errorlevel 1 (
    echo.
    echo WARNING: this ledger is INCOMPLETE ^(ledgerComplete:false^).
    choice /C YN /M "Test anyway with --allow-incomplete"
    if errorlevel 2 (
        echo Aborted.
        exit /b 1
    )
    set "INCOMPLETE_FLAG=--allow-incomplete"
)

set /a TOTAL=0
for %%R in ("%RULES_DIR%\*.ts") do set /a TOTAL+=1
if %TOTAL%==0 (
    echo No rule files found in %RULES_DIR%
    exit /b 1
)
echo Rules to test: %TOTAL%

set "LEDGER_BYTES=0"
for %%S in ("%SELECTED%\ledger.jsonl") do set "LEDGER_BYTES=%%~zS"
if %LEDGER_BYTES% GTR 500000000 (
    for /f %%i in ('powershell -NoProfile -Command "[int]([math]::Round(%LEDGER_BYTES% / 1073741824 * 0.4 + 0.5))"') do set /a EST_PER_RULE=%%i
    set /a EST_TOTAL=EST_PER_RULE * %TOTAL%
    set /a EST_HOURS=EST_TOTAL / 60
    echo NOTE: LARGE ledger - expect roughly !EST_PER_RULE! minutes of silent loading per rule.
    echo NOTE: total sweep estimate: about !EST_TOTAL! minutes - about !EST_HOURS! hours for %TOTAL% rules.
    echo NOTE: the console prints one line only when each rule FINISHES. Silence is normal.
    echo NOTE: do NOT start a second sweep while this one runs - each one needs several GB of RAM.
    echo.
)

if not exist "%REPORTS_DIR%" mkdir "%REPORTS_DIR%"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
set "REPORT=%REPORTS_DIR%\%SELECTED_NAME%_rules_%STAMP%.txt"

echo.
echo Writing full output to: %REPORT%
echo.

set /a DONE=0
set /a FAILS=0
set "TMP_OUT=%REPORTS_DIR%\tmp_%STAMP%.txt"
for %%R in ("%RULES_DIR%\*.ts") do (
    set /a DONE+=1
    echo [!DONE!/%TOTAL%] %%~nR
    call "%ESNO%" "%CHECKER%" "%SELECTED%" "%%R" %INCOMPLETE_FLAG% >"%TMP_OUT%" 2>&1
    findstr /B /C:"RULE " "%TMP_OUT%" 2>nul
    findstr /C:"trade-ledger-checker failed" "%TMP_OUT%" >nul
    if not errorlevel 1 set /a FAILS+=1
    >>"%REPORT%" echo ===== %%~nR =====
    type "%TMP_OUT%" >>"%REPORT%"
    >>"%REPORT%" echo.
)
del "%TMP_OUT%" >nul 2>&1
echo.
echo Done. Rules tested: %TOTAL%   Failures: %FAILS%
echo Full report: %REPORT%
echo.
echo ---------- SUMMARY (EDGE bar applied) ----------
call "%ESNO%" "%~dp0summarize-report.ts" "%REPORT%"
pause
