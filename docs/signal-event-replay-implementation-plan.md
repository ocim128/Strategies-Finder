# Signal-Event Replay — Implementation Plan

## Overview

A CLI research tool that tests whether any **current-time selection rule** can pick the best trade when multiple pairs signal simultaneously. This is the direct test that the Mine Timing / OPEN_SCORE / spread-quality investigations did NOT run — those tested direction prediction, pair-quality ranking, and aggregate filtering. This tests **relative selection among simultaneous signals**.

**Core question:** "At timestamp T, 5 pairs fire entry signals. Rule X picks pair #3. Does pair #3's trade outperform the average of the other 4?"

If no rule beats random selection, the conclusion "no tested method reliably selects the best trade" becomes "it is proven that no current-time selector can work" for this strategy universe.

---

## Problem Definition

The batch runner executes each pair independently with unlimited capital. In reality, when N pairs signal on the same bar and capital limits you to K < N, you must choose. The batch P&L (+$922k) assumes all trades are taken; the achievable P&L depends on the selection rule.

This tool replays existing batch trade data — **no re-running backtests**. It reads the entry/exit times and P&L from artifact trades, groups entries by timestamp, applies selection rules, and measures whether the rule beats random.

---

## Affected Modules and Files

### New files

| File | Purpose |
|---|---|
| `scripts/replay-signal-events.ts` | CLI script. Reads artifacts, groups trades by timestamp, applies rules, reports. |

### No modified files

This is a standalone CLI research script. No UI, no endpoint, no service wiring, no production code changes. Same pattern as `scripts/validate-spread-quality.ts`.

### Referenced (not modified)

| File | Why |
|---|---|
| `lib/batch-backtest/batch-synthetic-state-miner.ts:25-41` | `BatchSyntheticPairArtifact` shape (`symbol`, `baseAsset`, `quoteAsset`, `result.trades`) |
| `lib/types/strategies.ts:23-42` | `Trade` shape (`entryTime`, `exitTime`, `pnl`, `type`, `entryPrice`) |
| `scripts/validate-spread-quality.ts:68-97` | Artifact loading pattern to reuse (`findLatestArtifactDir`, `loadArtifactsFromDir`, v8 `deserialize`) |

---

## Architecture

### Data flow

```
Batch artifacts (temp dir, v8 .bin files)
  ↓
loadArtifactsFromDir (one file at a time, extract trades + metadata)
  ↓
Collect all trade entries: { symbol, baseAsset, quoteAsset, entryTime, exitTime, pnl, type }
  ↓
Group by entryTime (timestamp) → signal events
  ↓
For each multi-signal event (N > 1 pairs signaling simultaneously):
  ↓
Apply each selection rule → pick K trades (or rank all)
  ↓
Record: selected trade P&L vs average of all alternatives
  ↓
Aggregate: per-rule win rate vs random, IC of rule score vs realized P&L
  ↓
Report: does any rule beat random?
```

### Artifact loading

Reuse the pattern from `scripts/validate-spread-quality.ts:68-97`:
1. `findLatestArtifactDir()` — scan `tmpdir()` for `strategies-finder-batch-mine-*` directories, pick the most recent by mtime
2. `loadArtifactsFromDir(dir)` — read `.bin` files sequentially, `deserialize` each, extract `symbol`, `baseAsset`, `quoteAsset`, and `result.trades`
3. Must run within the 10-minute artifact TTL after a Batch Run

### Memory profile

Each artifact is ~5-10 MB (ratio OHLCV + signals + trades). But the replay only needs trade metadata — not the OHLCV. Extract trades per artifact and release the full artifact immediately. Peak memory = 1 artifact + accumulated trade entries (each ~100 bytes × ~1000 trades/pair × 512 pairs ≈ 50 MB of trade records). Manageable.

---

## Selection Rules to Test

Each rule computes a score for each candidate pair at a signal event. The rule selects the top-K (or top-1) by score. Rules use **only information available at entry time** — no lookahead.

### Rule implementations

All rules receive the list of candidate trades at a given timestamp and return a score per candidate. The score is computed from the candidate pair's **trade history up to (but not including) this entry**.

| Rule | Score | Data needed | Lookback |
|---|---|---|---|
| `random` | Math.random() | None | None (baseline) |
| `recent_sharpe` | Sharpe of last N trades' pnl | result.trades sorted by entryTime | N=10, 20 |
| `recent_winrate` | Win rate of last N trades | result.trades | N=5, 10 |
| `recent_avg_pnl` | Mean pnl of last N trades | result.trades | N=5, 10 |
| `recent_profit_factor` | Gross profit / gross loss of last N trades | result.trades | N=10 |
| `signal_rarity` | 1 / (number of trades in last 100 bars) | result.trades + bar timestamps | 100 bars |
| `time_since_last` | Bars since the pair's last trade exit | result.trades | None |
| `entry_volatility` | ATR% of the pair's ratio at entry bar | artifact.data (ratio OHLCV) | 14 bars |
| `momentum` | Return of the ratio over last N bars at entry | artifact.data (ratio closes) | N=5, 10, 20 |

### Constraints

- **Non-redundancy constraint:** optional flag to prevent selecting two pairs that share a common asset in the same event. When enabled, the rule picks the highest-scoring pair, removes all pairs sharing its assets, then picks the next highest, etc.

---

## Report Format

```
SIGNAL_REPLAY | pairs=<P> trades=<T> events=<E> multi_signal_events=<M>
SIGNAL_REPLAY | NOTE: tests whether selection rules beat random when multiple pairs signal simultaneously.
SIGNAL_REPLAY | Method: for each event where N>1 pairs signal, apply rule to pick top-1, record selected P&L vs event average.

RULE          | random:            avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | recent_sharpe_10:  avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | recent_winrate_5:  avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | recent_avg_pnl_5:  avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | signal_rarity:     avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | time_since_last:   avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | entry_volatility:  avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>
RULE          | momentum_5:        avg_selected_pnl=$<X> avg_alternative_pnl=$<Y> delta=$<D> win_rate=<WR%> n=<M>

VERDICT       | <BEST_RULE>: delta=$<D> win_rate=<WR%> | <VERDICT_TEXT>
```

**Definitions:**
- `avg_selected_pnl`: mean P&L of the trade selected by the rule across all multi-signal events
- `avg_alternative_pnl`: mean P&L of all non-selected trades across the same events
- `delta`: avg_selected_pnl − avg_alternative_pnl (positive = rule beats average)
- `win_rate`: fraction of events where the selected trade's P&L > the event's average P&L

**Verdict logic:**
- `win_rate > 55%` AND `delta > 0` → **POTENTIAL_EDGE** — rule may have signal-selection value
- `win_rate` between 45-55% OR `delta` ≈ 0 → **NO_EDGE** — rule does not beat random
- `win_rate < 45%` AND `delta < 0` → **ANTI** — rule is counter-predictive

---

## Implementation Phases

### Phase 1: CLI script + core replay engine

**Objective:** Build the standalone script that loads artifacts, groups trades by entry timestamp, and runs the replay.

**Scope:** `scripts/replay-signal-events.ts` only.

**Technical tasks:**

1. **Artifact loading.** Reuse pattern from `scripts/validate-spread-quality.ts`:
   - `findLatestArtifactDir()` — scan tmpdir for `strategies-finder-batch-mine-*`
   - `loadTradesFromDir(dir)` — read each `.bin`, `deserialize`, extract trades with pair metadata, release artifact

2. **Trade extraction.** For each artifact, extract:
   ```ts
   interface SignalTrade {
     symbol: string;
     baseAsset: string;
     quoteAsset: string;
     entryTimeSec: number;
     exitTimeSec: number;
     pnl: number;
     type: "long" | "short";
   }
   ```
   Filter to `type === "long"` (the strategy is long-only).

3. **Signal-event grouping.** Group all SignalTrades by `entryTimeSec`. A "signal event" is a set of trades with the same entry timestamp. Multi-signal events have N > 1.

4. **Rule implementations.** Each rule is a function:
   ```ts
   type SelectionRule = (
     candidates: SignalTrade[],
     pairHistory: Map<string, SignalTrade[]>, // sorted by entryTime, up to but not including current
     pairBars: Map<string, OHLCVData[]>, // ratio OHLCV for volatility/momentum rules
   ) => SignalTrade // the selected trade (top-1)
   ```
   For `top-K` selection (future extension), return a ranked array instead.

5. **Replay engine.**
   - Sort all SignalTrades chronologically by `entryTimeSec`
   - For each multi-signal event:
     - Build `pairHistory` from all trades with `entryTimeSec < currentEventTime` for each candidate's symbol
     - Apply each rule
     - Record selected P&L and alternative P&Ls
   - Aggregate per rule

6. **Report builder.** Format per the report spec above.

7. **CLI args:**
   - `--top-k` (default 1): how many trades to select per event
   - `--no-redundancy`: skip pairs sharing assets with already-selected pairs
   - `--rules`: comma-separated rule names to test (default: all)
   - `--lookback`: override default lookback windows (e.g., `--lookback 5,10,20`)

**Dependencies:** None (pure CLI, reads existing artifacts).

**Risks:**
- **Entry timestamp alignment:** synthetic pair bars share timestamps by construction (base.time = quote.time = ratio.time). But the `executionModel: next_open` setting means the actual fill is at the next bar's open, not at the signal bar's close. The trade's `entryTime` field should reflect the actual fill time. Must verify this.
- **Pair history availability:** at the first event, there's no history for any pair. Rules must handle empty history gracefully (fall back to random or skip).
- **Ratio OHLCV for volatility/momentum rules:** these need `artifact.data`, which means loading the full artifact (5-10 MB per pair). For 512 pairs this is manageable if done sequentially and the data is released after extraction.

**Deliverables:**
- `scripts/replay-signal-events.ts`
- `npm run replay:signal-events` in `package.json`

**Validation:**
- Script runs on a real batch and produces output.
- Random rule produces `win_rate ≈ 50%` and `delta ≈ $0` (sanity check).
- All rules handle empty history (first events) without crashing.

**Exit criteria:** Script produces a complete report for all rules on a real batch.

---

### Phase 2 (conditional): Walk-forward validation

**Objective:** If Phase 1 finds a rule with `win_rate > 55%`, validate it OOS via temporal split.

**Scope:** Extend the script with walk-forward folds.

**Technical tasks:**

1. Split the signal events into chronological halves (or rolling folds).
2. On the first half, compute the rule's aggregate win rate and delta.
3. On the second half, apply the same rule and measure OOS win rate.
4. Report whether the edge persists.

**Dependencies:** Phase 1 complete AND at least one rule shows `win_rate > 55%`.

**Exit criteria:** OOS verdict documented. If the edge doesn't persist, the rule is noise.

---

### Phase 3 (conditional): UI integration

**Objective:** If Phase 2 validates a rule, build a UI button that shows the live selection recommendation.

**Scope:** New endpoint + button + panel (same pattern as Mine Prediction).

**Dependencies:** Phase 2 passes (rule has OOS edge).

**Exit criteria:** Button works, shows recommended pairs when multiple signals fire.

---

## Performance

- **Trade extraction:** 512 artifacts × ~1000 trades each = ~500K SignalTrade records. Each ~100 bytes. Total ~50 MB in memory after extraction.
- **Signal-event grouping:** single sort by entryTimeSec + groupBy. O(N log N).
- **Per-rule computation:** for each multi-signal event, compute scores for each candidate. With ~10K events × ~5 candidates × 9 rules = ~450K score computations. Each is O(lookback) for history-based rules. Total: seconds.
- **Ratio OHLCV rules (volatility, momentum):** need to load artifact data (5-10 MB per pair). Load one pair at a time, extract the entry-bar values, release. 512 × ~7 MB = ~3.5 GB total loaded sequentially, but peak memory = 1 artifact at a time.

---

## Failure Handling

| Case | Handling |
|---|---|
| No artifacts in temp dir | Print error: "Run a Batch then immediately run this script" |
| Artifacts expired (TTL) | Same error |
| No multi-signal events (every pair trades at different times) | Print "0 multi-signal events — selection rules not testable" |
| Pair has no trade history at first event | Rules fall back to score=0 (equivalent to random for that pair) |
| All trades have same entryTimeSec | Single event with N=512 candidates — replay works but is one data point |
| Negative P&L trades | Include them — the question is relative selection, not absolute profitability |

---

## Assumptions and Unknowns

1. **entryTime = fill time:** The `Trade.entryTime` field should reflect the actual execution time (next bar open for `executionModel: next_open`). Must verify that two pairs signaling on the same bar produce trades with identical `entryTime` values. If they differ by 1 bar due to data alignment, the grouping will be off.

2. **Pair-level vs trade-level "best":** The replay measures whether the selected *trade* outperforms alternatives. It doesn't measure whether the selected *pair* is better long-term. These are different questions.

3. **Top-1 vs top-K:** Phase 1 tests top-1 selection (pick the single best trade). If capital allows K positions, top-K selection is a natural extension. The rule's ranking quality matters more than its top-1 accuracy.

4. **ExecutionModel impact:** With `next_open`, the entry price is the next bar's open, not the signal bar's close. The entry-bar volatility and momentum rules must use the signal bar (bar before entry), not the entry bar itself.

5. **Lookback bias in rules:** `recent_sharpe` etc. use the pair's own trade history. If a pair has few prior trades, the estimate is noisy. Minimum history thresholds (e.g., skip rule if < 5 prior trades) should be configurable.

6. **What "simultaneously" means:** Two pairs signaling on the same daily bar may not be truly simultaneous in execution (different markets, different open times). For daily bars this is a reasonable approximation. For 4h bars it's less precise.

---

## Validation Summary

| Check | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Manual smoke | Run batch → immediately run `npm run replay:signal-events` → report renders |
| Random sanity | Random rule win_rate ≈ 50%, delta ≈ $0 |
| Edge detection | Any rule with win_rate > 55% → proceed to Phase 2 |

---

## Rollback Strategy

- Single new file (`scripts/replay-signal-events.ts`) + 1 `package.json` entry. Removing them reverts cleanly.
- No production code changes. No UI, no endpoint, no service wiring.
