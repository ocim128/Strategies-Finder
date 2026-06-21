@echo off
setlocal enabledelayedexpansion
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
:: If either prerequisite is missing, this block is skipped silently and
:: Vite still launches normally — the tunnel is opt-in.
set "TUNNEL_NAME="
set "LOCAL_PROXY_TOKEN="
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0.env") do (
        set "_line=%%a"
        if not "!_line:~0,1!"=="#" (
            if /i "%%a"=="TUNNEL_NAME" set "TUNNEL_NAME=%%b"
            if /i "%%a"=="LOCAL_PROXY_TOKEN" set "LOCAL_PROXY_TOKEN=%%b"
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
        echo [tunnel] TUNNEL_NAME not set in .env — skipping cloudflared.
        echo [tunnel] See comments in run_playground.bat for one-time setup.
    )
) else (
    echo [tunnel] cloudflared.exe not found — skipping tunnel.
    echo [tunnel] Install with: winget install cloudflare.cloudflared
)

echo Starting Lightweight Charts Playground...
call npx vite
pause
