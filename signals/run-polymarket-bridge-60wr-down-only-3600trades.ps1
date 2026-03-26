param(
    [string]$StrategyFinderRoot = '',
    [int]$Bars = 500,
    [int]$FreshnessBars = 0
)

$ErrorActionPreference = 'Stop'

$ConfigName = '60wr-down-only-3600trades'
$ConfigSlug = '60wr-down-only-3600trades'
$StrategyKey = 'zscore_false_break'
$Symbol = 'XRPUSDT'
$Interval = '5m'
$BotSymbol = 'xrp'

function Test-StrategyFinderRoot {
    param([string]$CandidatePath)
    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }
    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue
    if (-not $resolved) { return $false }
    $root = $resolved.Path
    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\export-latest-entry-signal.ts'))
}

function Find-StrategyFinderRootFromSeed {
    param([string]$SeedPath)
    if ([string]::IsNullOrWhiteSpace($SeedPath)) { return $null }
    $current = $SeedPath
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-StrategyFinderRoot $current) {
            return (Resolve-Path -LiteralPath $current).Path
        }
        $parent = Split-Path -Path $current -Parent
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
            break
        }
        $current = $parent
    }
    return $null
}

function Resolve-StrategyFinderRoot {
    param([string]$ExplicitPath)
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { $candidates += $ExplicitPath }
    if (-not [string]::IsNullOrWhiteSpace($env:STRATEGY_FINDER_ROOT)) { $candidates += $env:STRATEGY_FINDER_ROOT }
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $candidates += $PSScriptRoot }
    $candidates += (Get-Location).Path
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
        $candidates += (Join-Path $userProfile 'Documents\Repo\Experimental\lightweight-charts\debug\playground\Strategies-Finder')
        $candidates += (Join-Path $userProfile 'Documents\Strategies-Finder')
    }
    foreach ($candidate in $candidates) {
        $resolved = Find-StrategyFinderRootFromSeed $candidate
        if (-not [string]::IsNullOrWhiteSpace($resolved)) {
            return $resolved
        }
    }
    throw 'Could not locate the Strategies-Finder repo. Run this script from the repo, pass -StrategyFinderRoot, or set STRATEGY_FINDER_ROOT.'
}

function Write-Utf8NoBomFile {
    param(
        [string]$Path,
        [string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$StrategyFinderRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot
$BridgeDir = Join-Path $StrategyFinderRoot 'signals\bridge'
$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')
$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')
$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')
$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')
$RefreshScriptPath = Join-Path $BridgeDir ($ConfigSlug + '.refresh.ps1')
$BotEnvPath = Join-Path $BridgeDir ($ConfigSlug + '.bot.env')
$SignalPathForEnv = $SignalPath -replace '\\', '/'
$RefreshScriptPathForEnv = $RefreshScriptPath -replace '\\', '/'
New-Item -ItemType Directory -Path $BridgeDir -Force | Out-Null

$ParamsJson = @'
{
  "zscorePeriod": 18,
  "extremeLevel": -6.18,
  "reversalDepth": -1.7367
}
'@

$BacktestJson = @'
{
  "atrPeriod": 21,
  "stopLossAtr": 0,
  "takeProfitAtr": 0.1,
  "trailingAtr": 0,
  "partialTakeProfitAtR": 0,
  "partialTakeProfitPercent": 0,
  "breakEvenAtR": 0,
  "breakEvenPercent": 0,
  "timeStopBars": 0,
  "riskMode": "simple",
  "stopLossPercent": 0,
  "takeProfitPercent": 0,
  "takeProfitMode": "fixed",
  "takeProfitMfeLookbackTrades": 100,
  "takeProfitMfePercentile": 60,
  "takeProfitShrinkageStrength": 20,
  "takeProfitMomentumRsiPeriod": 14,
  "takeProfitMomentumRsiPauseLevel": 60,
  "takeProfitMomentumDecayPercentPerBar": 0.15,
  "takeProfitVelocityFastBars": 2,
  "takeProfitVelocitySlowBars": 20,
  "takeProfitVelocityProgressPercent": 50,
  "takeProfitVelocityExpandMultiplier": 1.5,
  "takeProfitVelocityShrinkMultiplier": 0.65,
  "takeProfitAtrScaledMultiplier": 1.5,
  "takeProfitRangeScaledLookback": 20,
  "takeProfitRangeScaledFraction": 0.3,
  "takeProfitMedianBarLookback": 20,
  "takeProfitMedianBarMultiplier": 2,
  "takeProfitMfeBootstrapPercentile": 60,
  "stopLossEnabled": false,
  "takeProfitEnabled": false,
  "riskMaxHoldBars": 8,
  "riskMaxHoldEnabled": true,
  "riskWinStreakStopLossEnabled": false,
  "riskWinStreakStopLossAfterWins": 3,
  "riskWinStreakStopLossPercent": 0,
  "marketMode": "all",
  "tradeFilterMode": "none",
  "htfBiasEmaPeriod": 200,
  "executionTrendEmaPeriod": 50,
  "trendPersistenceWindow": 5,
  "trendPersistenceMinBars": 4,
  "trendSlopeLookback": 5,
  "trendSlopeMinPercent": 0.2,
  "confirmLookback": 1,
  "volumeSmaPeriod": 20,
  "volumeMultiplier": 1.5,
  "tradeDirection": "short",
  "invertSignals": false,
  "flipAfterConsecutiveLosses": 2,
  "flipCooldownTrades": 0,
  "minTradesBeforeFirstFlip": 0,
  "executionModel": "next_open",
  "allowSameBarExit": false,
  "slippageBps": 0,
  "maxOpenTrades": 1,
  "warmUpEntryEnabled": false,
  "strategyTimeframeEnabled": false,
  "strategyTimeframeMinutes": 120,
  "twoHourCloseParity": "odd",
  "snapshotAtrFilterToggle": false,
  "snapshotAtrPercentMin": 0,
  "snapshotAtrPercentMax": 0,
  "snapshotVolumeFilterToggle": false,
  "snapshotVolumeRatioMin": 0,
  "snapshotVolumeRatioMax": 0,
  "snapshotAdxFilterToggle": false,
  "snapshotAdxMin": 0,
  "snapshotAdxMax": 0,
  "snapshotEmaFilterToggle": false,
  "snapshotEmaDistanceMin": 0,
  "snapshotEmaDistanceMax": 0,
  "snapshotRsiFilterToggle": false,
  "snapshotRsiMin": 0,
  "snapshotRsiMax": 0,
  "snapshotPriceRangePosFilterToggle": false,
  "snapshotPriceRangePosMin": 0,
  "snapshotPriceRangePosMax": 0,
  "snapshotBarsFromHighFilterToggle": false,
  "snapshotBarsFromHighMax": 0,
  "snapshotBarsFromLowFilterToggle": false,
  "snapshotBarsFromLowMax": 0,
  "snapshotTrendEfficiencyFilterToggle": false,
  "snapshotTrendEfficiencyMin": 0,
  "snapshotTrendEfficiencyMax": 0,
  "snapshotAtrRegimeFilterToggle": false,
  "snapshotAtrRegimeRatioMin": 0,
  "snapshotAtrRegimeRatioMax": 0,
  "snapshotBodyPercentFilterToggle": false,
  "snapshotBodyPercentMin": 0,
  "snapshotBodyPercentMax": 0,
  "snapshotWickSkewFilterToggle": false,
  "snapshotWickSkewMin": 0,
  "snapshotWickSkewMax": 0,
  "snapshotVolumeTrendFilterToggle": false,
  "snapshotVolumeTrendMin": 0,
  "snapshotVolumeTrendMax": 0,
  "snapshotVolumeBurstFilterToggle": false,
  "snapshotVolumeBurstMin": 0,
  "snapshotVolumeBurstMax": 0,
  "snapshotVolumePriceDivergenceFilterToggle": false,
  "snapshotVolumePriceDivergenceMin": 0,
  "snapshotVolumePriceDivergenceMax": 0,
  "snapshotVolumeConsistencyFilterToggle": false,
  "snapshotVolumeConsistencyMin": 0,
  "snapshotVolumeConsistencyMax": 0,
  "snapshotCloseLocationFilterToggle": false,
  "snapshotCloseLocationMin": 0,
  "snapshotCloseLocationMax": 0,
  "snapshotOppositeWickFilterToggle": false,
  "snapshotOppositeWickMin": 0,
  "snapshotOppositeWickMax": 0,
  "snapshotRangeAtrFilterToggle": false,
  "snapshotRangeAtrMultipleMin": 0,
  "snapshotRangeAtrMultipleMax": 0,
  "snapshotMomentumFilterToggle": false,
  "snapshotMomentumConsistencyMin": 0,
  "snapshotMomentumConsistencyMax": 0,
  "snapshotBreakQualityFilterToggle": false,
  "snapshotBreakQualityMin": 0,
  "snapshotBreakQualityMax": 0,
  "snapshotTf60PerfFilterToggle": false,
  "snapshotTf60PerfMin": 0,
  "snapshotTf60PerfMax": 0,
  "snapshotTf90PerfFilterToggle": false,
  "snapshotTf90PerfMin": 0,
  "snapshotTf90PerfMax": 0,
  "snapshotTf120PerfFilterToggle": false,
  "snapshotTf120PerfMin": 0,
  "snapshotTf120PerfMax": 0,
  "snapshotTf480PerfFilterToggle": false,
  "snapshotTf480PerfMin": 0,
  "snapshotTf480PerfMax": 0,
  "snapshotTfConfluencePerfFilterToggle": false,
  "snapshotTfConfluencePerfMin": 0,
  "snapshotTfConfluencePerfMax": 0,
  "snapshotEntryQualityScoreFilterToggle": false,
  "snapshotEntryQualityScoreMin": 0,
  "snapshotEntryQualityScoreMax": 0,
  "initialCapital": 10000,
  "positionSize": 100,
  "commission": 0,
  "fixedTradeToggle": true,
  "sizingMode": "fixed",
  "fixedTradeAmount": 1000,
  "useRustEngine": true,
  "riskSettingsToggle": true,
  "tradeFilterSettingsToggle": false,
  "confirmRsiPeriod": 14,
  "confirmRsiBullish": 55,
  "confirmRsiBearish": 45
}
'@

$CapitalJson = @'
{
  "initialCapital": 10000,
  "positionSize": 100,
  "commission": 0,
  "sizingMode": "fixed",
  "fixedTradeAmount": 1000
}
'@

Write-Utf8NoBomFile -Path $ParamsPath -Content $ParamsJson
Write-Utf8NoBomFile -Path $BacktestPath -Content $BacktestJson
Write-Utf8NoBomFile -Path $CapitalPath -Content $CapitalJson

$RefreshScript = @'
param(
    [string]$StrategyFinderRoot = '',
    [int]$Bars = 500,
    [int]$FreshnessBars = 0
)

$ErrorActionPreference = 'Stop'

function Test-StrategyFinderRoot {
    param([string]$CandidatePath)
    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }
    $resolved = Resolve-Path -LiteralPath $CandidatePath -ErrorAction SilentlyContinue
    if (-not $resolved) { return $false }
    $root = $resolved.Path
    return (Test-Path (Join-Path $root 'package.json')) -and (Test-Path (Join-Path $root 'scripts\export-latest-entry-signal.ts'))
}

function Resolve-StrategyFinderRoot {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-StrategyFinderRoot $ExplicitPath) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }
        throw ('Invalid StrategyFinderRoot: ' + $ExplicitPath)
    }
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'PSScriptRoot is empty. Pass -StrategyFinderRoot explicitly.'
    }
    $signalsDir = Split-Path -Path $PSScriptRoot -Parent
    if ([string]::IsNullOrWhiteSpace($signalsDir)) {
        throw 'Could not resolve signals directory from bridge refresh script.'
    }
    $candidateRoot = Split-Path -Path $signalsDir -Parent
    if (Test-StrategyFinderRoot $candidateRoot) {
        return (Resolve-Path -LiteralPath $candidateRoot).Path
    }
    throw ('Could not resolve Strategies-Finder root from ' + $PSScriptRoot + '. Pass -StrategyFinderRoot explicitly.')
}

$StrategyKey = 'zscore_false_break'
$Symbol = 'XRPUSDT'
$Interval = '5m'
$ConfigSlug = '60wr-down-only-3600trades'

$ResolvedRoot = Resolve-StrategyFinderRoot -ExplicitPath $StrategyFinderRoot
$BridgeDir = Join-Path $ResolvedRoot 'signals\bridge'
$ParamsPath = Join-Path $BridgeDir ($ConfigSlug + '.params.json')
$BacktestPath = Join-Path $BridgeDir ($ConfigSlug + '.backtest.json')
$CapitalPath = Join-Path $BridgeDir ($ConfigSlug + '.capital.json')
$SignalPath = Join-Path $BridgeDir ($ConfigSlug + '.latest-entry-signal.json')

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCommand) {
    throw 'npm was not found on PATH.'
}

Push-Location $ResolvedRoot
try {
    & $npmCommand.Source run signal:export -- --strategy $StrategyKey --symbol $Symbol --interval $Interval --bars $Bars --freshness-bars $FreshnessBars --params-file $ParamsPath --backtest-settings-file $BacktestPath --capital-settings-file $CapitalPath --out $SignalPath
    if ($LASTEXITCODE -ne 0) {
        throw ('signal:export exited with code ' + $LASTEXITCODE)
    }
}
finally {
    Pop-Location
}

Write-Host ('Signal refreshed: ' + $SignalPath)

'@

Write-Utf8NoBomFile -Path $RefreshScriptPath -Content $RefreshScript

$BotEnv = @"
TRADING_MODE=external_signal
DRY_RUN=true
EXTERNAL_SIGNAL_SYMBOL=$BotSymbol
EXTERNAL_SIGNAL_FILE=$SignalPathForEnv
EXTERNAL_SIGNAL_POLL_INTERVAL_MS=2000
EXTERNAL_SIGNAL_MAX_SIGNAL_LAG_SECS=600
EXTERNAL_SIGNAL_LOG_FILE=logs/external_signal.jsonl
EXTERNAL_SIGNAL_REFRESH_SCRIPT=$RefreshScriptPathForEnv
EXTERNAL_SIGNAL_REFRESH_DELAY_SECS=2
EXTERNAL_SIGNAL_REFRESH_TIMEOUT_SECS=120
MULTI_WALLET_NON_INTERACTIVE=true
WALLET_1_STRATEGY=external_signal
"@
Write-Utf8NoBomFile -Path $BotEnvPath -Content $BotEnv

& $RefreshScriptPath -StrategyFinderRoot $StrategyFinderRoot -Bars $Bars -FreshnessBars $FreshnessBars

Write-Host ('Bridge ready for ' + $ConfigName)
Write-Host ('Signal file: ' + $SignalPath)
Write-Host ('Refresh script: ' + $RefreshScriptPath)
Write-Host ('Bot env snippet: ' + $BotEnvPath)
