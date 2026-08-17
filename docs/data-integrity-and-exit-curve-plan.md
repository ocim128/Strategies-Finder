# Data Integrity Preflight & Sleeve Exit Curve — Technical Plan

Status: planned (no implementation yet)
Date: 2026-08-17
Source: research-feature ideas screening (journal: `archive/asset opportunity/Decay Anchor Reversion/research-notes-2026-08-16.md`, "Research-feature ideas screened")

Two independent operator-run analysis surfaces, delivered together:

1. **Market Data Integrity Preflight** — a deterministic scan of the local IBKR 30m seed
   CSVs that reports stale tails, split-jump candidates, timestamp gaps, duplicate bars,
   history-depth cohorts, and raw/quote overlap BEFORE expensive Finder/Batch runs.
   Motivated by two real incidents this session: a silently stale `SPY.csv` (2 days
   behind the universe, broke the fresh-gate benchmark) and per-symbol history-depth
   differences (~3.5k vs ~13k 4H buckets) that silently distorted analysis.
2. **Sleeve Exit Curve** — an exit-horizon curve over EXISTING sleeve signals
   (eigen, robust_zscore, open_clearance X/NVDA, open_clearance flow>=2): net return,
   MAE/MFE, exposure, and return-per-exposure-bar at exit horizons 1/3/5/8/12/15 bars,
   with a uniform-random entry control and the cost ruler. This is the pre-registered
   "exit research" step from the raw-leg plan; it changes no entries.

Both are **standalone esno scripts** following the repo's existing analysis-script
pattern (`scripts/analyze-asset-opportunity-holdouts.ts`, `scripts/audit-prepared-strategies.ts`).
No server routes, no UI, no engine changes in this phase.

---

## Part A — Data Integrity Preflight

### Objective

One command, `npm run data:preflight`, that prints a per-symbol integrity table plus a
summary line, and exits non-zero when any symbol is BLOCK-level defective. The operator
runs it after every IBKR sync and before Finder Universe / Batch runs.

### Tasks

1. Create `scripts/data-integrity-preflight.ts` (esno script, same invocation pattern as
   `scripts/analyze-asset-opportunity-holdouts.ts`).
2. Create a pure leaf module `lib/market-data/data-integrity-scan.ts` holding the
   scanner logic so tests can import it without filesystem scanning. The script is a thin
   wrapper: enumerate `price-data/ibkr/csv/30m/*.csv`, call the scanner per file,
   aggregate, print, set exit code.
3. Add npm script `"data:preflight": "esno scripts/data-integrity-preflight.ts"` beside
   `"ibkr:aggregate"` in `package.json`.
4. Add a focused spec `tests/data-integrity-scan.spec.ts` with synthetic CSV fixtures
   written to a temp dir covering each defect class.

### Scanner checks (per symbol)

All checks are streaming/whole-file reads of the 30m CSV using the existing parser
contract (`extractCandlesFromCsvPayload` from `lib/candle-cache.ts` handles the header
shape already used by `server-ibkr-csv-loader.ts`). Avoid importing the server loader
itself — it pulls server-only seams; read via `node:fs` + the shared parser.

| check | definition | verdict |
|---|---|---|
| `lastBarAge` | `now - lastTimestamp` | WARN if > 7 days, BLOCK if > 30 days |
| `maxGapBars` | largest timestamp gap divided by 30m | WARN if > 1 trading week of expected bars (≈ 78 bars) |
| `duplicateTimestamps` | repeated timestamps count | WARN if > 0 |
| `nonMonotonic` | timestamps decreasing anywhere | BLOCK |
| `splitJumpCandidates` | 1-bar close-to-close move with magnitude > threshold AND volume not proportionally elevated | WARN (flag only — needs human confirmation against corporate actions) |
| `historyDepthCohort` | total bar count bucketed (e.g. <2k, 2k-5k, 5k-10k, >10k) | informational column |
| `universeFreshnessSpread` | `universeMaxLastTimestamp - symbolLastTimestamp` | computed at summary level; symbols lagging the universe max by > 2 days get WARN (this is the stale-SPY detector) |
| `overlapWithQuotes` | count of timestamps shared with each common quote leg (SPY, NVDA) at the 30m seed grid | informational + WARN if < 60% for a designated quote leg |

Verdict semantics: `PASS` (no warnings), `WARN` (run permitted, defects listed),
`BLOCK` (deterministic corruption: non-monotonic timestamps, unparsable rows > threshold,
empty file). Exit code: 0 if no BLOCK, 1 if any BLOCK, 2 on usage errors. Warnings do
not fail the run; they print.

### Output contract (opaque report lines)

Follow the OPEN_SCORE precedent: the script prints a plain-text table plus a final
`PREFLIGHT | verdict=PASS|WARN|BLOCK | symbols=N pass=a warn=b block=c` summary line the
operator can paste into the journal verbatim. Table columns:
`SYMBOL | LAST_BAR | AGE_D | BARS | MAX_GAP_BARS | DUPES | JUMPS | DEPTH | VERDICT`.
A `--json` flag writes the same data as one JSON object to stdout instead (for future
tooling); no schema beyond that in this phase.

### Dependencies

- None new. Uses `node:fs`, `extractCandlesFromCsvPayload`, `lib/data/constants.ts`
  interval helpers if needed.

### Risks / blockers

- **Split-jump false positives**: earnings-day gaps can exceed naive thresholds. Mitigation:
  flag-only (WARN), never BLOCK, and state the threshold in the output
  (`jumpPct>30% & volRatio<1.5` initial guess, tuned after first scan).
- **Extended-hours buckets**: some symbols carry pre/post 4H buckets SPY never forms;
  the gap check runs on the 30m seed grid where this is less distorting, and the overlap
  check is informational, not gating.
- `.bak` files: the sync writes `<sym>.csv.bak` siblings; the scanner must enumerate
  only `*.csv`.

### Performance

503 files × ~19k rows. Streaming line reads with a running state machine (no full array
retention except the parser's own output) keeps this under ~30s. If the shared parser's
allocation is too heavy, parse timestamps only (first column) in a fast pre-pass and use
the full parser only for symbols that reach the jump check.

### Validation / exit criteria

- Spec covers: stale tail, gap, duplicate, non-monotonic, split-jump (with a benign
  high-volume gap fixture that must NOT flag), depth cohort, and the universe-spread
  summary.
- Manual run on the real 503-file dataset: SPY's previous 2-day lag scenario is detected
  by `universeFreshnessSpread` (verified by temporarily checking against a `.bak` copy in
  the spec, not by mutating real data).
- `npm run typecheck` and the new spec pass.

### Rollback

Delete `scripts/data-integrity-preflight.ts`, `lib/market-data/data-integrity-scan.ts`,
the spec, and the npm line. No other file is touched.

---

## Part B — Sleeve Exit Curve

### Objective

One command, `npm run analyze:sleeve-exit-curve`, that computes, for the four
pre-registered sleeve signal streams, the exit-horizon curve (1/3/5/8/12/15 bars) with
net return, MAE, MFE, exposure, return-per-exposure-bar, a uniform-random entry control,
and block-consistency counts. Read-only analysis of local data; prints an opaque report
the operator pastes into the journal.

### Signal streams (frozen; matches the fresh-data gate)

- `eigen` — `probability_boundary_eigen_shift` `{stateLookback: 50, eigenLimit: 3}` on RAW symbols
- `robustz` — `robust_zscore_typical_fade` `{lookback: 40}` on RAW symbols
- `clearanceNVDA` — `open_clearance_collapse_reversal` `{lookback: 22}` on X/NVDA ratio (30m ratio then 4H aggregate — the AGENTS-documented order)
- `clearanceFlow2` — `open_clearance` buy signals with flow >= 2 on RAW symbols

The construction (30m load → 4H aggregate → execute → next_open entry) mirrors
`archive/asset opportunity/fresh-data-gate.ts` exactly; the shared helpers should be
extracted from that script into the new analysis module rather than re-written
differently. **The gate script itself is NOT modified** — its pre-registered bars and
behavior stay frozen; we duplicate the small loaders into the new module (or extract to a
shared leaf and have the gate import it only if the diff is provably behavior-neutral;
default to duplication to avoid touching a pre-registered instrument).

### Metrics per (sleeve, exit horizon)

For every entry signal `i` (entry at `bars[i+1].open`, long side):

- `netReturn` = `bars[i+H].close / bars[i+1].open - 1` minus 30 bps round trip (cost ruler: 0.1% commission + 2×10 bps slippage)
- `MAE` = min over `j in [i+1, i+H]` of `bars[j].low / bars[i+1].open - 1`
- `MFE` = max over `j` of `bars[j].high / bars[i+1].open - 1`
- `retPerExposureBar` = `netReturn / H`
- `SPYexcess` = trade net minus SPY open→close over the same window (SPY leg costless; report coverage count — partial coverage is structural, extended-hours buckets)
- positive-block count: split trades into 10 chronological blocks per sleeve, count blocks with positive mean net

### Uniform-random control

For each sleeve and horizon, draw the same number of entries from the same symbol set at
uniformly random bar indices (seeded RNG — the repo uses deterministic seeded behavior
elsewhere; use a fixed literal seed so runs are reproducible), constrained to bars where
the sleeve's symbol actually traded and entry/exit complete. Report
`mean sleeve − mean random` per horizon. This is a diagnostic control, not a pass/fail
gate — the exit curve's pre-registered question (from the journal) is: *"For the ratio
failed-breakout sleeve, does the 5-bar exit retain ≥ 80% of the 12-bar net return while
improving net return per exposure-bar by ≥ 20% in ≥ 7 of 10 blocks?"* — the report
prints the answer components; the operator journals the verdict.

### Output contract

Opaque report lines per sleeve:
```
EXIT_CURVE | sleeve=<key> | horizon=<H> | n=<trades> | net=<%/t> | MAE=<%> | MFE=<%> | retPerExpBar=<%/b> | SPYex=<%> (cov a/b) | +blocks=k/10
CONTROL    | sleeve=<key> | horizon=<H> | randomNet=<%/t> | delta=<pp>
```
Plus a final summary answering the pre-registered question per sleeve.

### Tasks

1. Create `lib/research/sleeve-exit-curve.ts` (pure leaf: loaders + metric computation,
   no DOM imports — mirrors the leaf-module convention used by the batch replay engines).
2. Create `scripts/sleeve-exit-curve.ts` (thin esno wrapper: run over all symbols,
   aggregate, print).
3. npm script `"analyze:sleeve-exit-curve"`.
4. Spec `tests/sleeve-exit-curve.spec.ts` with a synthetic 4H fixture: hand-computable
   prices verifying netReturn/MAE/MFE arithmetic, the cost deduction, the control
   seeding, and the block split.

### Data flow

`price-data/ibkr/csv/30m/*.csv` → 30m maps (shared loader) → per-symbol 4H agg (or
X/NVDA ratio-then-agg) → strategy `execute` (imported from `lib/strategies/lib/*`) →
signal index list → per-horizon forward windows from the same bar arrays → aggregate →
print. No writes anywhere.

### Dependencies

- Preflight is NOT a runtime dependency, but the operator habit is: run preflight first,
  then the exit curve (a stale symbol silently shrinks the curve's sample).

### Risks / blockers

- **Overlap between trades**: consecutive signals share forward windows. The report is
  descriptive (like the holdout reports) and prints the caveat line; the block counts
  are the honest dependence heuristic, mirroring the replay engine's approach.
- **Extended-hours buckets vs SPY**: same structural partial coverage as the gate; print
  `cov a/b`, never impute.
- **Sample size for flow2/eigen on raw**: the full-history sample (not just the fresh
  window) is used here, so n is large; the fresh-gate sleeves remain untouched.

### Validation / exit criteria

- Spec green; typecheck green.
- Manual run: curves for all four sleeves print; eigen/robustz 12-bar net within
  arithmetic distance of the values already journaled from the fresh-gate full-history
  proxy runs (they will not match exactly — different construction: engine vs local —
  but signs and rough magnitudes should agree; document the comparison in the journal).
- The pre-registered exit question prints its answer components for the ratio sleeve.

### Rollback

Delete the two new files, the spec, and the npm line. Nothing else touched.

---

## Shared assumptions / unknowns (both parts)

- **Assumption**: 30m CSV header is always `time,open,high,low,close,volume` (verified
  across the dataset; the shared parser tolerates case variants).
- **Assumption**: `.bak` files are sync artifacts, never analysis inputs.
- **Unknown**: the split-jump threshold's false-positive rate on real data — the first
  full-dataset run is the calibration; expect the jump column to be noisy initially and
  tune once, documenting the change.
- **Unknown**: whether extracting the gate's loaders into a shared leaf can be done
  byte-behavior-neutral; default is duplication (gate untouched) unless proven.
- **Out of scope**: server routes, UI panels, blocking Finder/Batch on preflight verdicts,
  any change to strategy code, any change to the fresh-data gate. All of those are
  possible follow-ups once the scripts prove useful.

## File map (all new; nothing existing is modified except `package.json` scripts)

```
lib/market-data/data-integrity-scan.ts        (new, pure leaf)
scripts/data-integrity-preflight.ts           (new, esno wrapper)
lib/research/sleeve-exit-curve.ts             (new, pure leaf)
scripts/sleeve-exit-curve.ts                  (new, esno wrapper)
tests/data-integrity-scan.spec.ts             (new)
tests/sleeve-exit-curve.spec.ts               (new)
package.json                                   (+2 script lines)
docs/data-integrity-and-exit-curve-plan.md    (this document)
```
