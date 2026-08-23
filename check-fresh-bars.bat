@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "$baseline = [datetime]'2026-08-21T20:00:00Z'; $bars = Get-Content 'price-data\ibkr\csv\4h\SPY.csv' | Where-Object { $_ -match '^\d' -and ([datetime]($_ -split ',')[0]) -gt $baseline }; $n = @($bars).Count; Write-Host ('Fresh bars since 2026-08-21T20:00Z: ' + $n + ' / ~100 needed'); if ($n -ge 100) { Write-Host 'FRESH WINDOW OPEN - judged batch may run' } else { $weeks = [math]::Ceiling((100 - $n) / 15); Write-Host ('~' + $weeks + ' more weekly syncs to go') }"
pause
