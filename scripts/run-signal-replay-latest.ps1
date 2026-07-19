[CmdletBinding()]
param(
    [ValidateSet("next_open", "signal_close")]
    [string]$ExecutionModel = "next_open",

    [ValidateSet("long", "short", "both")]
    [string]$Direction = "both",

    [ValidateRange(1, 1000000)]
    [int]$MinTestEvents = 100,

    [ValidateRange(1, 120)]
    [int]$TrainMonths = 6,

    [ValidateRange(1, 120)]
    [int]$TestMonths = 3,

    [ValidateRange(0, 2147483647)]
    [int]$Seed = 42,

    [ValidateRange(1, 60)]
    [int]$MaxAgeMinutes = 10
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$esnoPath = Join-Path $repoRoot "..\..\..\node_modules\.bin\esno.cmd"

if (-not (Test-Path -LiteralPath $esnoPath -PathType Leaf)) {
    throw "Repository esno runner not found at $esnoPath. Run npm install from the main repository first."
}

$tempRoot = [System.IO.Path]::GetTempPath()
$artifactCandidates = @(
    Get-ChildItem -LiteralPath $tempRoot -Directory -Filter "strategies-finder-batch-mine-*" |
        ForEach-Object {
            $binFiles = @(Get-ChildItem -LiteralPath $_.FullName -Filter "*.bin" -File -ErrorAction SilentlyContinue)
            if ($binFiles.Count -gt 0) {
                [PSCustomObject]@{
                    Path = $_.FullName
                    LastWriteTime = ($binFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
                    BinCount = $binFiles.Count
                }
            }
        } |
        Sort-Object LastWriteTime -Descending
)

if ($artifactCandidates.Count -eq 0) {
    throw "No Batch artifact directory with .bin files was found. Run a fresh Batch Backtest first."
}

$selectedArtifact = $artifactCandidates[0]
$artifactAgeMinutes = ((Get-Date) - $selectedArtifact.LastWriteTime).TotalMinutes
if ($artifactAgeMinutes -gt $MaxAgeMinutes) {
    throw "Newest artifact is $([math]::Round($artifactAgeMinutes, 1)) minutes old (limit $MaxAgeMinutes). Run Batch again before replay."
}

Write-Host "Using artifact: $($selectedArtifact.Path)"
Write-Host "Artifacts: $($selectedArtifact.BinCount), age: $([math]::Round($artifactAgeMinutes, 1)) minutes"
Write-Host "Execution model: $ExecutionModel, direction: $Direction, train/test months: $TrainMonths/$TestMonths, minimum events/fold: $MinTestEvents"

Push-Location $repoRoot
try {
    & $esnoPath "scripts/replay-signal-events.ts" `
        "--artifact-dir" $selectedArtifact.Path `
        "--execution-model" $ExecutionModel `
        "--direction" $Direction `
        "--train-months" $TrainMonths `
        "--test-months" $TestMonths `
        "--min-test-events" $MinTestEvents `
        "--seed" $Seed
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
