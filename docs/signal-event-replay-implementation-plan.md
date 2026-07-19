# Signal-Event Replay — Implementation Plan

## Overview

A CLI research tool that tests whether any **current-time selection rule** can pick the best trade when multiple pairs signal simultaneously. This is a **ranking diagnostic**, not a portfolio backtest. It measures whether a rule's ranking of simultaneously-signaling pairs correlates with realized trade outcomes — using strict causal walk-forward validation.

**Core question:** "At signal time T, 5 pairs fire entry signals. Rule X ranks pair #3 highest. Does pair #3's completed trade outperform the event average?"

If no rule beats random after walk-forward validation, the conclusion is: no tested selection rule shows reliable OOS ranking value in this universe and configuration.

---

## Design Principles (learned from prior investigations)

1. **Walk-forward is mandatory, not conditional.** Prior investigations (Mine Timing, spread quality) failed because they searched full history first, then validated conditionally. This tool runs chronological folds from the start — rule/lookback selection on train, evaluation on the next test fold.
2. **Causal history only.** A trade's P&L is unknown until it exits. Rules may only use trades with `exitTime < signalTime`. Including still-open trades would leak future information.
3. **Normalized returns, not raw dollars.** Different pairs have different entry prices and position sizes. Use `pnlPercent` (fee-aware) as the primary outcome.
4. **Seeded everything.** Random baseline and tie-breaking use a fixed seed. Results are reproducible.
5. **Ranking mode only for v1.** This tool measures ranking ability (does the rule put better trades higher?). It does NOT simulate portfolio capacity, open positions, or capital constraints. That is a separate tool.

---

## Data Flow

```
Batch artifacts (temp dir, v8 .bin files)
  ↓ (--artifact-dir required)
Load artifacts one at a time:
  extract signalTime, fillTime, exitTime, pnlPercent, direction, pair metadata
  extract causal feature snapshots (volatility, momentum) at signal bar
  release artifact immediately
  ↓
Collect all SignalCandidate records
  ↓
Group by signalTime → signal events
  ↓
Chronological walk-forward folds:
  For each fold:
    Train segment: select best rule/lookback by in-fold ranking IC
    Test segment: apply frozen rule, measure paired return delta vs event mean
  ↓
Aggregate OOS results across test folds
  ↓
Report: paired delta, percentile rank, block-bootstrap CI, verdict
```

---

## SignalCandidate Shape

```ts
interface SignalCandidate {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  signalTimeSec: number;   // bar before fill (decision time)
  fillTimeSec: number;     // entryTime of the trade (next_open fill)
  exitTimeSec: number;     // exitTime of the completed trade
  direction: "long" | "short";
  netReturnPct: number;    // pnlPercent (fee-aware, comparable across pairs)
  entryFeatures: {
    volatilityPct: number | null;      // ATR% at signal bar (14-bar)
    momentum5: number | null;          // 5-bar ratio return at signal bar
    momentum10: number | null;         // 10-bar ratio return at signal bar
    momentum20: number | null;         // 20-bar ratio return at signal bar
    timeSinceLastExitBars: number | null; // bars since this pair's last trade exited
    signalRarity: number | null;       // 1 / count of this pair's signals in last 100 bars
  };
}
```

Feature snapshots are computed **while the artifact is loaded** (one at a time), attached as scalars to each candidate, then the OHLCV array is released. No `Map<string, OHLCVData[]>` is retained.

---

## Selection Rules

Each rule computes a score for each candidate at a signal event. Higher score = ranked higher.

| Rule | Score formula | Type |
|---|---|---|
| `random` | Seeded pseudo-random | Baseline |
| `recent_return_mean_std_N` | Mean / StdDev of last N exited trades' netReturnPct | Negative control (recent performance persistence) |
| `recent_winrate_N` | Fraction of wins in last N exited trades | Negative control |
| `recent_avg_return_N` | Mean netReturnPct of last N exited trades | Negative control |
| `recent_profit_factor_N` | Sum(wins) / abs(Sum(losses)) in last N exited trades | Negative control |
| `time_since_last_exit` | Bars since this pair's last trade exited | Execution-quality candidate |
| `signal_rarity` | 1 / signal count in last 100 bars | Execution-quality candidate |
| `entry_volatility` | ATR% at signal bar (lower = higher score) | Risk-based candidate |
| `momentum_N` | N-bar ratio return at signal bar | Directional negative control |

**Rules labeled "negative control"** are families already shown unreliable at the pair level. Testing them at the signal-event level is useful to confirm they also fail here. They are NOT expected to pass.

**Rules labeled "execution-quality candidate"** have not been tested at any level. They are the rules most likely to show something new.

**`momentum_N`** is explicitly a directional predictor. It is included as a negative control to confirm that direction doesn't help even at the signal-event grain.

### Causal history constraint

`recent_*` rules use only trades where `exitTimeSec < currentSignalTimeSec`. A trade entered before the event but still open is excluded — its P&L is unknown at decision time.

### Tie-breaking

When two candidates have the same score (including score=0 for empty history), break ties using a **seeded deterministic random** (not alphabetical/file order). The seed is a CLI argument (default: 42).

---

## Walk-Forward Validation (mandatory in Phase 1)

### Fold structure

- **Fold unit:** 3 calendar months (configurable via `--fold-months`)
- **Train:** all signal events in the fold
- **Test:** all signal events in the next fold
- **Non-overlapping walk-forward:** train → test → advance by one fold → repeat

### Per-fold evaluation

For each fold:
1. On the **train** segment: compute each rule's ranking IC (Spearman of rule-score vs realized netReturnPct across all multi-signal events)
2. Select the best rule/lookback by train IC
3. On the **test** segment: apply the frozen rule, record per-event paired delta (selected return − event mean return)

### Aggregation across test folds

- Mean paired delta (selected − event_mean)
- Median paired delta
- Fraction of test folds with positive mean delta
- Block-bootstrap 95% CI on mean delta (block = calendar month)
- Oracle regret: mean delta of (best-possible selection − event_mean) as ceiling

---

## Report Format

```
SIGNAL_REPLAY | artifact-dir=<path> pairs=<P> trades=<T> events=<E> multi_signal_events=<M>
SIGNAL_REPLAY | mode=ranking | outcome=netReturnPct | seed=42 | folds=<F>
SIGNAL_REPLAY | NOTE: ranking diagnostic only. Does not simulate portfolio capacity or capital constraints.

FOLD <i>/<F> | train=<date>..=<date> test=<date>..=<date> | events=<N> | best_train_rule=<RULE> train_IC=<X>

OOS_RULE  | <BEST_RULE>: mean_delta=+0.XX% median=+0.XX% pos_folds=<N>/<F> bootstrap_CI=[+0.XX, +0.XX]
OOS_RULE  | random:       mean_delta=+0.XX% median=+0.XX% pos_folds=<N>/<F> bootstrap_CI=[+0.XX, +0.XX]
OOS_CEIL  | oracle:       mean_delta=+0.XX% (upper bound — best possible top-1 selection)

VERDICT   | <VERDICT_TEXT>
```

**Verdict logic (from OOS test folds only):**
- Mean paired delta > 0 AND block-bootstrap 95% CI excludes 0 AND ≥60% of test folds positive → **OOS_EDGE**: rule shows reliable signal-event ranking value
- Otherwise → **NO_OOS_EDGE**: no tested rule reliably ranks simultaneous signals better than random

The statement "no tested rule reliably ranks simultaneous signals" does NOT mean "no possible selector can work." It means the tested rules in this universe/configuration do not.

---

## Affected Modules and Files

### New files

| File | Purpose |
|---|---|
| `scripts/replay-signal-events.ts` | CLI script with walk-forward replay engine |
| `tests/replay-signal-events.spec.ts` | Pure-function unit tests for the replay core |

### Modified files

| File | Change |
|---|---|
| `package.json` | Add `"replay:signal-events": "esno scripts/replay-signal-events.ts"` |

### Referenced (not modified)

| File | Why |
|---|---|
| `lib/batch-backtest/batch-synthetic-state-miner.ts:25-41` | `BatchSyntheticPairArtifact` shape |
| `lib/types/strategies.ts:23-42` | `Trade` shape (`entryTime`, `exitTime`, `pnlPercent`, `type`) |
| `lib/types/strategies.ts:455` | `Signal` shape (has `time` and `barIndex` for signal-time extraction) |
| `lib/strategies/index.ts` | `timeKey` for timestamp normalization |
| `scripts/validate-spread-quality.ts:68-97` | Artifact loading pattern (`findLatestArtifactDir`, `loadArtifactsFromDir`, v8 `deserialize`) |

---

## Implementation Phases

### Phase 1: Walk-forward replay engine + CLI

**Objective:** Build the script that tests all selection rules with mandatory chronological walk-forward validation.

**Scope:** `scripts/replay-signal-events.ts` + `tests/replay-signal-events.spec.ts` + `package.json` entry.

**Technical tasks:**

1. **Artifact loading** (reuse pattern from `validate-spread-quality.ts`):
   - `--artifact-dir` CLI flag (required — do NOT auto-discover latest; explicit for reproducibility)
   - Load one `.bin` at a time, deserialize, extract signals + trades + feature snapshots, release
   - Extract `signalTime` from the artifact's `signals[]` array (the `Signal.time` field at the bar before the trade's `entryTime`), or fall back to `entryTime - 1 bar` if signals are not available

2. **SignalCandidate extraction.** For each trade in each artifact:
   - `signalTimeSec`: normalized from `Signal.time` or computed as the bar before `entryTime`
   - `fillTimeSec`: `Number(trade.entryTime)` via `timeKey`/`timeToNumber`
   - `exitTimeSec`: `Number(trade.exitTime)`
   - `netReturnPct`: `trade.pnlPercent`
   - `direction`: `trade.type`
   - `entryFeatures`: computed from ratio OHLCV at the signal bar index, then OHLCV released

3. **Feature computation** (while artifact is loaded):
   - `volatilityPct`: ATR(14) / close × 100 at the signal bar
   - `momentumN`: (close[signalBar] / close[signalBar - N] - 1) × 100
   - `timeSinceLastExitBars`: signal bar index − last exited trade's exit bar index
   - `signalRarity`: 1 / count of signals in last 100 bars from this pair

4. **Causal history ledger.** Maintain a per-pair sorted list of completed trades. At each signal event, a pair's history includes only trades with `exitTimeSec < signalTimeSec`. Append to the ledger only after a trade exits, not when it enters.

5. **Signal-event grouping.** Group candidates by `signalTimeSec`. Multi-signal events have N > 1.

6. **Rule implementations.** Each rule receives candidates + causal history and returns a score per candidate. Use `--direction long|short|both` CLI flag (not hardcoded to long).

7. **Walk-forward replay engine:**
   - Chronological folds (3-month default)
   - Train: compute per-rule ranking IC, select best rule/lookback
   - Test: apply frozen rule, record per-event paired delta
   - Aggregate OOS results

8. **Block bootstrap.** For the 95% CI on mean delta: resample test-fold months with replacement (1000 iterations), compute mean delta per resample, take 2.5th and 97.5th percentiles.

9. **Report builder.** Format per spec above.

10. **CLI args:**
    - `--artifact-dir <path>` (required)
    - `--fold-months <N>` (default 3)
    - `--seed <N>` (default 42)
    - `--direction long|short|both` (default both)
    - `--top-k <N>` (default 1)
    - `--no-redundancy` (for top-K: skip pairs sharing assets with already-selected)

**Dependencies:** None (pure CLI).

**Risks:**
- **signalTime inference:** if `signals[]` is not available on the artifact (stripped during serialization), must fall back to `fillTime - 1 bar`. The artifact shape at `BatchSyntheticPairArtifact.signals` should be present for synthetic pairs (the runner stores it). Must verify.
- **Low multi-signal event count:** if most pairs trade at different times, there may be too few multi-signal events for meaningful statistics. The report must state the count; if < 100 OOS events, the verdict is "insufficient data."
- **Feature computation cost:** loading 512 artifacts sequentially to compute ATR/momentum snapshots. Each artifact ~7 MB, loaded one at a time, features extracted, released. Total ~3.5 GB loaded but peak memory ~10 MB.

**Deliverables:** `scripts/replay-signal-events.ts` + spec + package.json entry.

**Validation:**
- `tests/replay-signal-events.spec.ts` with:
  - Causal history test: a trade entered before an event but exited after is NOT in the history ledger
  - Grouping test: two trades with next_open fills are grouped by their signal bar, not fill bar
  - Random baseline test: mean paired delta ≈ 0 (not win_rate ≈ 50%)
  - Tie-breaking test: deterministic under a fixed seed
  - pnlPercent ranking test: raw $ differences do not affect ranking when normalized returns are equal
- `npm run typecheck` clean
- Manual smoke: run after a batch → report renders

**Exit criteria:** Script produces a complete walk-forward report with OOS verdict.

---

### Phase 2 (conditional): UI integration

**Objective:** If Phase 1 finds a rule with OOS_EDGE, build a UI button that shows live selection recommendation.

**Dependencies:** Phase 1 verdict is OOS_EDGE.

**Not planned in detail until Phase 1 passes.**

---

## Performance

- **Artifact loading + feature extraction:** 512 artifacts × ~7 MB, loaded sequentially. Features extracted while loaded, then released. Wall time: ~30-60 seconds.
- **Signal-event grouping:** sort ~500K SignalCandidate records by signalTimeSec. O(N log N). Seconds.
- **Rule computation per event:** O(candidates × lookback) per event. With ~10K events × ~5 candidates × 9 rules ≈ 450K computations. Seconds.
- **Block bootstrap:** 1000 iterations × O(events). Seconds.
- **Memory peak:** ~10 MB (1 artifact) + ~50 MB (SignalCandidate array for 500K trades at ~100 bytes each).

---

## Failure Handling

| Case | Handling |
|---|---|
| `--artifact-dir` not provided or invalid | Error: require explicit path for reproducibility |
| No artifacts in dir | Error: "Run a Batch then use --artifact-dir <path>" |
| No multi-signal events | Report: "0 multi-signal events — selection rules not testable on this universe" |
| < 100 OOS multi-signal events | Verdict: "INSUFFICIENT_DATA — too few events for reliable conclusion" |
| Pair has no exited trade history at first events | Score = 0 for recent_* rules; seeded random tie-break resolves ties |
| Direction filter removes all candidates | Report: "0 candidates after direction filter" |

---

## Assumptions and Unknowns

1. **signalTime availability:** The artifact carries `signals[]` (confirmed for synthetic pairs at `BatchSyntheticPairArtifact.signals`). Each Signal has `time` and `barIndex`. If present, `signalTime = Signal.time`. If not present, fall back to `fillTime - 1 bar` on the ratio OHLCV timeline.

2. **pnlPercent comparability:** `Trade.pnlPercent` is fee-aware and computed as `pnl / (entryPrice × size) × 100`. It should be comparable across pairs with different entry prices. Must verify that all pairs in the batch used the same `positionSizePercent` (100%) and `commissionPercent`.

3. **Completed-trade bias:** This replay only includes trades that actually completed. Signals that were blocked because a position was already open are NOT in the artifact's trades. This means the replay overstates the number of available slots — some "competing" signals would not have been executable. This is a known limitation of ranking mode vs a full capacity replay.

4. **Entry OHLCV availability:** `volatilityPct` and `momentumN` need ratio OHLCV at the signal bar. The artifact's `data` field has this. The feature is computed during artifact loading, before the data is released.

5. **Time normalization:** `Time` can be unix seconds, milliseconds, ISO strings, or `BusinessDay`. Use `timeKey` from `lib/strategies/index.ts` for normalization. Do NOT use raw `Number(trade.entryTime)`.

---

## Rollback Strategy

- `scripts/replay-signal-events.ts` + `tests/replay-signal-events.spec.ts` + 1 `package.json` entry. Removing them reverts cleanly. No production code changes.
