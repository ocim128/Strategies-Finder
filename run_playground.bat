@echo off
setlocal enabledelayedexpansion

:: Elevated-relaunch entry point: when this bat re-launches itself with
:: `_CERT_INSTALL` as the first arg (admin via UAC), jump straight to the
:: cert install block and exit. Prevents the elevated child from also
:: killing ports and starting the gateway.
if /i "%~1"=="_CERT_INSTALL" goto :do_cert_install

echo Cleaning up existing processes...

:: Kill port 5173 (Vite)
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
    echo Killing Vite process PID: %%i
    taskkill /f /pid %%i >nul 2>&1
)

:: Kill port 3030 (Rust Engine)
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :3030 ^| findstr LISTENING') do (
    echo Killing Rust Engine process PID: %%i
    taskkill /f /pid %%i >nul 2>&1
)

:: Kill port 5000 (IBKR Client Portal Gateway)
set "IBKR_GATEWAY_WAS_KILLED="
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    echo Killing IBKR Client Portal Gateway process PID: %%i
    set "IBKR_GATEWAY_WAS_KILLED=1"
    taskkill /f /pid %%i >nul 2>&1
)
if defined IBKR_GATEWAY_WAS_KILLED timeout /t 2 /nobreak >nul

:: --- One-time IBKR gateway cert trust -----------------------------------
:: The shipped price-data/clientportal.gw/root/vertx.jks contains an IBKR
:: self-signed cert that EXPIRED in 2019; modern browsers refuse to load
:: https://localhost:5000/ at all (cert error before any login page). We
:: regenerate the keystore with a fresh self-signed localhost cert (10-year
:: validity, same alias/password the gateway config expects: localhost /
:: mywebapi) and install the cert into Cert:\LocalMachine\Root so Chrome and
:: Edge trust it permanently.
::
:: Idempotent: if a localhost cert is already trusted, this is a sub-second
:: no-op. Requires admin to write to LocalMachine\Root; self-elevates via UAC
:: and waits for the elevated child to finish before continuing.
call :ensure_ibkr_cert

set "IBKR_GATEWAY_PID="
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do (
    set "IBKR_GATEWAY_PID=%%i"
)

if defined IBKR_GATEWAY_PID (
    echo IBKR Client Portal Gateway already running on port 5000, PID: !IBKR_GATEWAY_PID!
) else (
    set "IBKR_GATEWAY_DIR=%~dp0price-data\clientportal.gw"
    if exist "!IBKR_GATEWAY_DIR!\bin\run.bat" (
        where java >nul 2>&1
        if errorlevel 1 (
            echo [ibkr] Java was not found on PATH. Install Java or add it to PATH before using IBKR price sync.
        ) else (
            echo Starting IBKR Client Portal Gateway on https://localhost:5000 ...
            start "IBKR Client Portal Gateway" cmd /k "cd /d ""!IBKR_GATEWAY_DIR!"" && call bin\run.bat root\conf.yaml"
            timeout /t 2 /nobreak >nul
        )
    ) else (
        echo [ibkr] Gateway not found at !IBKR_GATEWAY_DIR! - skipping IBKR startup.
    )
)

echo Starting Rust Trading Engine...
start "Rust Trading Engine" cmd /k "cd /d "%~dp0..\..\..\trading-engine" && cargo run --release"

:: --- Optional cloudflared tunnel ------------------------------------------
:: Exposes the local Vite server (port 5173) to a stable public URL so the
:: deployed Cloudflare Worker can fetch candles from this machine via
:: LOCAL_CANDLE_PROXY_URL. Required because Binance geo-blocks Cloudflare
:: egress IPs; the user's residential IP is unaffected.
::
:: Activation requires BOTH:
::   1. cloudflared.exe installed (winget install cloudflare.cloudflared)
::   2. TUNNEL_NAME=<your-named-tunnel> in .env, created once via:
::        cloudflared tunnel login
::        cloudflared tunnel create <name>
::        cloudflared tunnel route dns <name> <hostname.yourdomain>
::      Then put the resulting https://<hostname.yourdomain> URL into
::      wrangler.toml as LOCAL_CANDLE_PROXY_URL and redeploy the worker.
::      Also set LOCAL_PROXY_TOKEN to the same secret in both .env and
::      `wrangler secret put LOCAL_CANDLE_PROXY_TOKEN`.
::
:: This block ALSO exports ALPACA_API_KEY / ALPACA_API_SECRET from .env into
:: the shell environment so the IBKR sync plugin's Alpaca fetcher can read
:: them via process.env server-side. Vite's built-in .env loader only exposes
:: VITE_-prefixed vars to import.meta.env (client); non-prefixed server
:: secrets must be exported by the launcher, exactly like LOCAL_PROXY_TOKEN.
::
:: If either prerequisite is missing, this block is skipped silently and
:: Vite still launches normally - the tunnel is opt-in.
set "TUNNEL_NAME="
set "LOCAL_PROXY_TOKEN="
set "ALPACA_API_KEY="
set "ALPACA_API_SECRET="
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0.env") do (
        set "_line=%%a"
        if not "!_line:~0,1!"=="#" (
            if /i "%%a"=="TUNNEL_NAME" set "TUNNEL_NAME=%%b"
            if /i "%%a"=="LOCAL_PROXY_TOKEN" set "LOCAL_PROXY_TOKEN=%%b"
            if /i "%%a"=="ALPACA_API_KEY" set "ALPACA_API_KEY=%%b"
            if /i "%%a"=="ALPACA_API_SECRET" set "ALPACA_API_SECRET=%%b"
        )
    )
)

set "CLOUDFLARED_EXE="
where cloudflared >nul 2>&1 && set "CLOUDFLARED_EXE=cloudflared"
if not defined CLOUDFLARED_EXE if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CLOUDFLARED_EXE=C:\Program Files (x86)\cloudflared\cloudflared.exe"

if defined CLOUDFLARED_EXE (
    if defined TUNNEL_NAME (
        if not "!TUNNEL_NAME!"=="" (
            echo Starting cloudflared tunnel: !TUNNEL_NAME!
            start "cloudflared tunnel" cmd /k ""!CLOUDFLARED_EXE!" tunnel run !TUNNEL_NAME!"
        )
    ) else (
        echo [tunnel] TUNNEL_NAME not set in .env - skipping cloudflared.
        echo [tunnel] See comments in run_playground.bat for one-time setup.
    )
) else (
    echo [tunnel] cloudflared.exe not found - skipping tunnel.
    echo [tunnel] Install with: winget install cloudflare.cloudflared
)

echo Starting Lightweight Charts Playground...
cd /d "%~dp0"
echo !NODE_OPTIONS! | findstr /C:"--max-old-space-size" >nul 2>&1
if errorlevel 1 (
    if defined NODE_OPTIONS (
        set "NODE_OPTIONS=--max-old-space-size=16384 !NODE_OPTIONS!"
    ) else (
        set "NODE_OPTIONS=--max-old-space-size=16384"
    )
    echo [node] NODE_OPTIONS=!NODE_OPTIONS!
)
:: Invoke the workspace-installed Vite shim directly. `npx vite` asks npm to
:: remap every workspace first and aborts when sibling Git worktrees contain
:: another package with the same name.
set "VITE_CMD=%~dp0..\node_modules\.bin\vite.cmd"
if exist "!VITE_CMD!" (
    call "!VITE_CMD!"
) else (
    echo [vite] Workspace Vite shim not found at !VITE_CMD! - falling back to npx.
    call npx --no-install vite
)
pause
exit /b 0

:: ===========================================================================
:: Subroutine: ensure the IBKR gateway's self-signed TLS cert is trusted.
:: Idempotent. Self-elevates via UAC if not admin. Synchronous: caller waits.
:: ===========================================================================
:ensure_ibkr_cert
set "GW_DIR=%~dp0price-data\clientportal.gw"
set "JKS=%GW_DIR%\root\vertx.jks"
set "CER=%GW_DIR%\root\vertx.cer"

:: Skip silently if the gateway isn't installed locally.
if not exist "%GW_DIR%\bin\run.bat" exit /b 0

:: Locate keytool.exe next to java.exe on PATH.
set "KEYTOOL="
for /f "delims=" %%j in ('where java 2^>nul') do (
    if not defined KEYTOOL (
        set "JAVA_BIN=%%~dpj"
        if exist "!JAVA_BIN!keytool.exe" set "KEYTOOL=!JAVA_BIN!keytool.exe"
    )
)
if not defined KEYTOOL (
    echo [ibkr-cert] keytool.exe not found next to java.exe - skipping cert trust.
    exit /b 0
)

:: Idempotency check: if a localhost cert is already in LocalMachine\Root,
:: assume setup is complete and skip everything. PowerShell exits 1 if the
:: cert is present, 0 if absent.
powershell -NoProfile -Command "$c = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*CN=localhost*' -and $_.Issuer -like '*CN=localhost*' }; if (-not $c) { exit 0 } else { exit 1 }" 2>nul
if errorlevel 1 (
    echo [ibkr-cert] Cert already trusted in LocalMachine\Root - skipping.
    exit /b 0
)

:: Cert needs to be installed. Requires admin to write to LocalMachine\Root.
:: If we're not admin, self-elevate a fresh cmd that runs :do_cert_install
:: and exits; we wait for it before continuing.
net session >nul 2>&1
if errorlevel 1 (
    echo [ibkr-cert] Cert install requires admin - requesting elevation...
    :: Pass the batch path through the environment so PowerShell/cmd do not
    :: have to parse it through another nested quoting layer. Explicitly set
    :: the working directory because an elevated process cannot use a mapped
    :: or otherwise unavailable drive inherited from the parent shell.
    set "_IBKR_CERT_BAT=%~f0"
    powershell -NoProfile -Command "try { $bat = $env:_IBKR_CERT_BAT; Start-Process -FilePath $bat -ArgumentList '_CERT_INSTALL' -WorkingDirectory (Split-Path -Parent $bat) -Verb RunAs -Wait -WindowStyle Normal -ErrorAction Stop; exit 0 } catch { Write-Host '[ibkr-cert] Elevation failed:' $_.Exception.Message; exit 1 }"
    set "_IBKR_CERT_BAT="
    if errorlevel 1 (
        echo [ibkr-cert] UAC declined or unavailable. The browser will reject the gateway cert
        echo [ibkr-cert] until you run this bat as admin once, or manually trust the cert.
    ) else (
        :: Re-verify the cert is now trusted (child install succeeded).
        powershell -NoProfile -Command "$c = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*CN=localhost*' }; if (-not $c) { exit 1 } else { exit 0 }" 2>nul
        if not errorlevel 1 (
            echo [ibkr-cert] Cert trusted via elevated install.
        ) else (
            echo [ibkr-cert] Elevated child did not leave a trusted cert - re-run as admin to diagnose.
        )
    )
    exit /b 0
)

:: Fall-through path: we ARE admin and install is needed. Call the install
:: block directly (also the entry point for the elevated relaunch).
call :do_cert_install
exit /b 0

:do_cert_install
:: Self-contained: also the entry point for the elevated relaunch, so it
:: must derive all paths itself rather than rely on :ensure_ibkr_cert state.
set "GW_DIR=%~dp0price-data\clientportal.gw"
set "JKS=%GW_DIR%\root\vertx.jks"
set "CER=%GW_DIR%\root\vertx.cer"
set "KEYTOOL="
for /f "delims=" %%j in ('where java 2^>nul') do (
    if not defined KEYTOOL (
        set "JAVA_BIN=%%~dpj"
        if exist "!JAVA_BIN!keytool.exe" set "KEYTOOL=!JAVA_BIN!keytool.exe"
    )
)
if not defined KEYTOOL (
    echo [ibkr-cert] keytool.exe not found next to java.exe - cannot install cert.
    exit /b 1
)

echo [ibkr-cert] Installing fresh localhost cert (one-time setup)...

:: Backup the original vertx.jks once, so the user can roll back.
if not exist "%JKS%.orig" (
    copy /y "%JKS%" "%JKS%.orig" >nul
    echo [ibkr-cert] Backed up original vertx.jks to vertx.jks.orig
)

:: Generate a fresh keystore with a 10-year self-signed localhost cert using
:: the same alias/password the gateway config expects (localhost / mywebapi).
"%KEYTOOL%" -genkeypair -alias localhost -keyalg RSA -keysize 2048 -sigalg SHA256withRSA -validity 3650 -keystore "%JKS%" -storetype JKS -storepass mywebapi -keypass mywebapi -dname "CN=localhost, OU=Client Portal, O=Local Dev, L=Local, ST=Local, C=US" -ext SAN=dns:localhost,ip:127.0.0.1,ip:::1 >nul 2>&1
if errorlevel 1 (
    echo [ibkr-cert] keytool failed to generate new keystore - restoring original.
    if exist "%JKS%.orig" copy /y "%JKS%.orig" "%JKS%" >nul
    exit /b 0
)

:: Export the cert and trust it in LocalMachine\Root.
"%KEYTOOL%" -exportcert -alias localhost -keystore "%JKS%" -storepass mywebapi -file "%CER%" -rfc >nul 2>&1
if errorlevel 1 (
    echo [ibkr-cert] keytool failed to export cert.
    exit /b 0
)

powershell -NoProfile -Command "try { Import-Certificate -FilePath '%CER%' -CertStoreLocation Cert:\LocalMachine\Root -ErrorAction Stop | Out-Null; exit 0 } catch { Write-Host '[ibkr-cert] Import-Certificate failed:' $_.Exception.Message; exit 1 }"
if errorlevel 1 exit /b 0

echo [ibkr-cert] Done. https://localhost:5000/ will now open without cert warnings.
:: If running as the elevated relaunch child, keep the window open briefly so
:: the user can read the result before it closes.
if /i "%~1"=="_CERT_INSTALL" timeout /t 3 /nobreak >nul
exit /b 0

