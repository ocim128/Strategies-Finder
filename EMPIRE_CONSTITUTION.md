# EMPIRE CONSTITUTION

Date ratified: 2026-02-15

## Mandate
This document is the single source of truth for the Twin Towers production profile:
- `lib/strategies/lib/sol_queen_v1.ts`
- `lib/strategies/lib/btc_queen_v1.ts`
- `lib/strategies/manifest.ts`

No parameter drift is allowed without a new Constitution revision.

## Final Determination (Operation Horizon)
Status: `CONCLUDED`  
Outcome: `Twin Towers are the proven peak.`

Portfolio evidence:
- Twin Towers (baseline): Max Drawdown `19.21%`, Net Profit `274.35%`
- Trinity (+ Bear Hunter): Max Drawdown `28.51%`, Net Profit `59.27%`
- Quad (+ Meta Harvest): Max Drawdown `30.54%`, Net Profit `23.07%`

Conclusion:
- Adding hedges/diversifiers degraded stability and returns relative to the Twin Towers baseline.
- The empire is locked to the two Queen strategies only.

## Iron Core: SOL Queen v1 (Locked)
Strategy key: `sol_queen_v1`  
Asset scope: `SOL`  
Structure (locked):
- `volWindow: 21`
- `volLookback: 126`
- `fastPeriod: 50`
- `slowPeriod: 200`

Thresholds / behavior (locked):
- `useSpikeRegime: 1`
- `useRecoveryRegime: 1`
- `useLowVolDeRisk: 1`
- `useMlOverlay: 1`
- `adaptiveLookbacks: 0`
- `adaptiveStrengthPct: 0`
- `minAdaptiveFactor: 1`
- `maxAdaptiveFactor: 1`
- `spikePercentilePct: 80`
- `calmPercentilePct: 25`
- `oversoldRetPct: 3`
- `extensionPct: 5`
- `mlBullThresholdPct: 60`
- `entryExposurePct: 60.0518`
- `exitExposurePct: 37.4696`
- `entryConfirmBars: 2`
- `exitConfirmBars: 2`
- `minHoldBars: 13`
- `cooldownBars: 6`

Oxygen / execution settings (locked):
- `riskMode: "simple"`
- `stopLossAtr: 2.5`
- `takeProfitAtr: 0`
- `trailingAtr: 0`
- `timeStopBars: 0`
- `tradeFilterMode: "adx"`
- `adxMin: 20`
- `adxMax: 0`
- `confirmLookback: 1`

## Iron Core: BTC Queen v1 (Locked)
Strategy key: `btc_queen_v1`  
Asset scope: `BTC`  
Structure (locked):
- `volWindow: 26`
- `volLookback: 149`
- `fastPeriod: 39`
- `slowPeriod: 268`

Thresholds / behavior (locked):
- `useSpikeRegime: 1`
- `useRecoveryRegime: 1`
- `useLowVolDeRisk: 1`
- `useMlOverlay: 1`
- `adaptiveLookbacks: 0`
- `adaptiveStrengthPct: 0`
- `minAdaptiveFactor: 1`
- `maxAdaptiveFactor: 1`
- `spikePercentilePct: 80`
- `calmPercentilePct: 25`
- `oversoldRetPct: 3`
- `extensionPct: 5`
- `mlBullThresholdPct: 60`
- `entryExposurePct: 67.3756`
- `exitExposurePct: 49.2985`
- `entryConfirmBars: 2`
- `exitConfirmBars: 2`
- `minHoldBars: 9`
- `cooldownBars: 6`

Oxygen / execution settings (locked):
- `riskMode: "simple"`
- `stopLossAtr: 1.5`
- `takeProfitAtr: 0`
- `trailingAtr: 0`
- `timeStopBars: 0`
- `tradeFilterMode: "adx"`
- `adxMin: 15`
- `adxMax: 0`
- `confirmLookback: 1`

## Benchmark (Twin Towers 50/50)
Reference run: `batch-runs/portfolio-twin-towers-2026-02-15/portfolio-twin-towers.json`

Portfolio benchmark:
- Combined Net Profit: `274.35%`
- Combined Max Drawdown: `19.21%`

These values define the accepted baseline for this Constitution revision.

## Strategic Scope (Locked)
Allowed focus:
- Backtest engine speed and reliability.
- Execution logic quality for the Queen strategies.
- Data/infra robustness and reproducibility.

Disallowed focus:
- Adding new production pillars.
- Diluting allocation with experimental hedges/diversifiers without a new constitutional rewrite.

## Refreeze Policy
No edits are allowed to:
- `lib/strategies/lib/sol_queen_v1.ts`
- `lib/strategies/lib/btc_queen_v1.ts`
- `lib/strategies/manifest.ts`

unless all conditions are met:
1. A new benchmark run is produced and stored under `batch-runs/`.
2. `scripts/verify-empire-integrity.ts` is updated to the new locked values.
3. This `EMPIRE_CONSTITUTION.md` is revised with the new parameters and benchmark.
