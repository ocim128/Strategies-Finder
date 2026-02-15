# The Twin Towers Strategy (SOL + BTC Empire)

Twin Towers is a locked two-strategy system:
- `sol_queen_v1` for SOL regime capture
- `btc_queen_v1` for BTC regime capture

## Benchmark (Constitution Baseline)
- Combined Net Profit: **274.35%**
- Combined Max Drawdown: **19.21%**
- Calmar Ratio: **~14**

Reference run:
- `batch-runs/portfolio-twin-towers-2026-02-15/portfolio-twin-towers.json`

## Iron Core Architecture
Each tower is a fossilized Dynamic VIX regime profile:
1. Locked volatility structure (lookbacks and trend periods).
2. Locked activation thresholds (entry/exit exposure, confirmations, hold/cooldown).
3. Locked Oxygen risk layer (ATR stop + ADX trade filter).

No walk-forward tuning is active on these production strategy files.

## The Guardians
- Constitution: `EMPIRE_CONSTITUTION.md`
- Integrity sentinel: `scripts/verify-empire-integrity.ts`

The sentinel enforces exact parameter identity for:
- `lib/strategies/lib/sol_queen_v1.ts`
- `lib/strategies/lib/btc_queen_v1.ts`
- Their locked backtest overrides

If any locked value drifts, the sentinel fails.

## Usage
1. Install and run:
```bash
npm install
npm run dev
```

2. In strategy selection, run:
- `sol_queen_v1` on `SOLUSDT 4h`
- `btc_queen_v1` on `BTCUSDT 4h`

3. Keep risk settings aligned with locked overrides from the Constitution.

## Integrity Check
Run before commits or releases:
```bash
npm run typecheck
..\..\..\node_modules\.bin\esno scripts\verify-empire-integrity.ts
```

Expected output:
```text
[EmpireIntegrity] PASS
```

## Refreeze Rule
Edits to the locked Empire files are prohibited unless a new Constitution revision is created:
1. New benchmark run in `batch-runs/`
2. Updated `EMPIRE_CONSTITUTION.md`
3. Updated `scripts/verify-empire-integrity.ts`
