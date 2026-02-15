# Strategies Finder Playground

Vite + TypeScript strategy research playground for backtesting, walk-forward analysis, and survivability-focused finder runs.

## Core philosophy
- This project should be used to filter fragile ideas, not optimize equity curves.
- A strategy is interesting only if it survives strict OOS pressure with realistic execution assumptions.
- Reproducibility is mandatory: seeded runs, fixed protocol, explicit pass/fail reasons.

## Quick start
```bash
npm install
npm run dev
```

Validation commands:
```bash
npm run typecheck
npm run test
npm run test:e2e
```

## Edge-finding workflow (recommended)
1. Start with one strategy, one market, one timeframe.
2. Use `Search Mode = Robust Random WF`.
3. Keep config fixed during a run set.
4. Run one fixed seed first (screening).
5. Run a fixed seed set (validation).
6. Promote only if behavior is stable across seeds and nearby cells.

## Single-seed vs multi-seed
- Single seed:
  - Purpose: fast, reproducible screening.
  - Example seed: `1337`.
- Multi-seed:
  - Purpose: robustness validation.
  - Example seed set: `1337, 7331, 2026, 4242, 9001`.
  - Rule of thumb: require at least `3/5` PASS per cell.

## robust_random_wf behavior
The mode is designed as a survivability filter.

- Enforces strict execution realism path.
- Uses staged filtering:
  1. Stage A holdout constraints.
  2. Stage B short fixed-param walk-forward constraints.
  3. Stage C full fixed-param walk-forward constraints.
- Final decision is explicit per cell:
  - `PASS`
  - `FAIL` with `decisionReason`
- `passRate` is based on Stage C survivors only.

## Audit trail and explainability
Each cell emits a structured audit event:
- `[Finder][robust_random_wf][cell_audit]`

Payload includes:
- seed and cellSeed
- sampled count
- stage A/B/C survivors
- passRate
- median OOS/stability/DD diagnostics
- final decision and reason code

Common fail reasons:
- `cell_low_stage_c_survivors`
- `cell_low_pass_rate`
- `cell_high_dd_breach_rate`
- `cell_high_fold_variance`

## Aggregate controlled runs
Use the built-in summary utility after collecting multiple run logs.

Table output:
```bash
npm run robust:summary -- run-seed-1337.txt run-seed-7331.txt run-seed-2026.txt
```

JSON output:
```bash
npm run robust:summary -- --format json --out matrix-summary.json run-seed-*.txt
```

Go/no-go report (policy gates, seed rule, and reject diagnostics):
```bash
npm run robust:report -- run-seed-1337.txt run-seed-7331.txt run-seed-2026.txt run-seed-4242.txt run-seed-9001.txt
```

Go/no-go JSON output:
```bash
npm run robust:report -- --format json --out go-no-go.json run-seed-*.txt
```

## Run robust finder from CLI
Use this when you want reproducible batch runs without UI actions.

1) Edit config:
- `scripts/robust-cli-config.example.json`

2) Run:
```bash
npm run robust:run -- --config scripts/robust-cli-config.example.json
```

If your shell/npm strips flag names, positional mode also works:
```bash
npm run robust:run -- scripts/robust-cli-config.example.json
```

What it does:
- Loads OHLCV JSON from `dataPath` (same format exported/imported by Data menu)
- Runs `robust_random_wf` for each seed
- Writes `run-seed-<seed>.txt` files (cell_audit lines)
- Generates summary/report tables
- Generates JSON outputs:
  - `matrix-summary-YYYY-MM-DD.json`
  - `go-no-go-YYYY-MM-DD.json`

## Run full matrix batch from CLI
Use this when you want one automated pass across many cells (`strategy x symbol x timeframe x filter x direction`).

1) Edit config:
- `scripts/robust-batch-config.example.json`

2) Run:
```bash
npm run robust:batch -- --config scripts/robust-batch-config.example.json
```

Positional fallback:
```bash
npm run robust:batch -- scripts/robust-batch-config.example.json
```

Batch output:
- Per-cell folders (for each symbol/timeframe/filter/direction):
  - `run-seed-<seed>.txt`
  - `matrix-summary-YYYY-MM-DD.json`
  - `go-no-go-YYYY-MM-DD.json`
  - `go-no-go-YYYY-MM-DD.txt`
- Batch-level artifacts in `output.outDir`:
  - `batch-manifest-YYYY-MM-DD.json`
  - `batch-matrix-summary-YYYY-MM-DD.json`
  - `batch-go-no-go-YYYY-MM-DD.json`
  - `batch-go-no-go-YYYY-MM-DD.txt`

Notes:
- Cell identity includes symbol + timeframe + trade filter + direction + strategy, so cross-market runs are not merged incorrectly.
- `reportPolicy` gates define final GO/NO_GO criteria for automation.

Accepted input files:
- Debug copy text containing `[Finder][robust_random_wf][cell_audit]` lines (recommended).
- Finder `Copy Top Results` JSON (PASS-only; useful but incomplete for reject diagnostics).

## Practical validation protocol
1. Freeze configuration:
  - costs, runs/range/steps, timeframe set, symbol set, data span.
2. Run a small controlled matrix:
  - few markets x few timeframes.
3. Run all seeds from a predefined list.
4. Reject cells with unstable cross-seed behavior.
5. Use cluster behavior as confirmation, not ranking.

## Important caveats
- Mock symbols are useful for pipeline/debug checks, not evidence of live edge.
- Do not reroll random seeds until a pass appears.
- If a strategy only survives one narrow corner, treat it as fragile.

## Useful code map
- Finder core: `lib/finder-manager.ts`, `lib/finder/*`
- Backtest service: `lib/backtest-service.ts`
- Walk-forward service: `lib/walk-forward-service.ts`
- Strategies: `lib/strategies/lib/*`
- Strategy registry: `strategyRegistry.ts`
- Alerts worker: `workers/entry-signal-worker.ts`

## Minimal hypothesis template strategy
- Built-in key: `hypothesis_trend_persistence`
- File: `lib/strategies/lib/hypothesis-trend-persistence.ts`
- Purpose: a minimal baseline for hypothesis testing (trend persistence) before adding complexity.
- Suggested workflow:
  - Validate this baseline first in `robust_random_wf`.
  - Change one idea at a time (entry condition, exit condition, risk gate), then re-run fixed seeds.
