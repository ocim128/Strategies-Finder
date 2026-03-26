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
