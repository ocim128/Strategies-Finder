# Rank Pairs

Rank Pairs classifies the regime of each synthetic pair's ratio path. It is a
browser-only, lazy-initialized research tab (registered in `lib/app-bootstrap.ts`).

- Markup source: `html-partials/tab-rank-pairs.html`
- Structural DOM contract: `lib/rank-pairs/rank-pairs-dom.ts`
- Pure classifier: `lib/rank-pairs/pair-regime-classifier.ts`
- Latest-200 classifier: `lib/rank-pairs/recent-pair-classifier.ts`
- UI service: `lib/rank-pairs/rank-pairs-service.ts`
- Full History datasets load through the shared Batch loader
  (`loadBatchDataset`). Latest 200 Bars uses a Rank-only compact leg cache and
  reverse aligned-close builder that stops after 200 target buckets; if the
  shallow window cannot produce 200 aligned bars, it retries at the Batch
  loader's full source depth.

## What the classifier measures

The ratio series for a `BASE+QUOTE` synthetic pair **is** `base.close /
quote.close` (see `docs/synthetic-pairs.md`). The classifier samples this ratio
at fixed **30-calendar-day anchors** over roughly three years, then emits
independent **direction** and **structure** labels.

Why calendar anchoring: the Batch loader serves `30m`, `4h`, and `1d` intervals
across both continuous crypto sessions and stock sessions. Anchoring on
30-calendar-day marks (rather than bar counts) makes the same ratio path
classify the same regardless of intra-period bar count, and avoids the
continuous-markets-only annualization the old scorer used.

### Anchored sampling

1. Normalize each candle time with `timeToNumber(...)`; drop non-positive closes.
2. Deduplicate timestamps last-write-wins; sort ascending by time.
3. Anchor the **latest** close, then select the latest candle at or before each
   preceding 30-calendar-day anchor.
4. Build **37 observations** (latest + 36 anchors). Reject an anchor whose
   nearest candle is more than **7 calendar days** older than the anchor target.
5. Coverage guard: require **≥33 valid anchors** and **≥960 elapsed calendar
   days**, otherwise the pair is `THIN`.
6. The latest 7 consecutive valid anchors form the **recent window** (6
   returns). Missing recent anchors disable `TRANSITION`/`REVERSAL`.
7. The result includes the latest candle's `asOf` timestamp, because a new
   latest candle moves every anchor and can change the current label.

### Metrics

Calculated from anchored log closes (all are scalar; `null` when undefined,
never coerced to zero):

- `ratioReturn` — `last/first - 1`
- `logReturn` — `ln(last) - ln(first)`
- `annualizedSlope` — OLS log-price slope regressed on calendar years
- `annualizedVolatility` — calendar-year variance rate from periodic log
  returns; for uniform 30-day spacing this is
  `sampleStdev(returns) * sqrt(365/30)`
- `normalizedDrift` — `annualizedSlope / annualizedVolatility`
- `pathEfficiency` — `abs(lastLog - firstLog) / sum(abs(periodicLogChange))`
- `reversalRate` — sign changes between nonzero periodic returns / eligible
  transitions
- `recentNormalizedDrift`, `recentPathEfficiency` — same metrics over the
  recent 7-anchor window
- `endpointRatio`, `endpointInsideBand` — last/first ratio and whether it sits
  inside the reciprocal `[1/1.30, 1.30]` band

### Labels

Direction and structure are **independent** and combined for display
(e.g. `BASE / TREND`, `NEUTRAL / OSCILLATING`):

- **Direction:** `BASE` (normalized drift ≥ +0.50), `QUOTE` (≤ −0.50),
  `NEUTRAL` (otherwise), `THIN` (coverage failure).
- **Structure:** `TREND`, `OSCILLATING`, `TRANSITION`, `REVERSAL`, `MIXED`,
  `THIN`.

For `TRANSITION` and `REVERSAL` the displayed direction uses the **recent**
drift, because the label describes the current regime.

Annualized volatility remains a numeric field. There is deliberately **no**
universe-relative volatility label whose meaning changes with the input list.

### Classification precedence

Evaluated top-down; first match wins:

1. `THIN` — anchor coverage or required-metric checks fail (reason codes
   `INSUFFICIENT_ANCHORS`, `INVALID_TIME`, `NO_VALID_CLOSES`, `ZERO_VARIANCE`).
2. `REVERSAL` — the pre-recent baseline is trending AND recent drift ≥ 0.75 in
   the opposite direction AND recent efficiency ≥ 0.40.
3. `TREND` continuation — the pre-recent baseline is trending AND recent drift
   ≥ 0.75 in the same direction AND recent efficiency ≥ 0.40.
4. `TRANSITION` — the pre-recent baseline is oscillating AND recent
   `|normalizedDrift|` ≥ 0.75 AND recent efficiency ≥ 0.40.
5. `MIXED` recent move — recent direction is strong but the pre-recent baseline
   is neither an established trend nor an established oscillation.
6. `TREND` — when no strong recent override applies, full
   `|normalizedDrift|` ≥ 0.50 AND full efficiency ≥ 0.25.
7. `OSCILLATING` — endpoint inside the reciprocal 30% band AND full efficiency
   ≤ 0.20 AND 30-day reversal rate ≥ 0.50.
8. `MIXED` — valid history that meets none of the above.

All thresholds are named constants in `pair-regime-classifier.ts`. Changing any
threshold is a behavior change that requires fixture and boundary-test updates
(`tests/rank-pairs-regime-classifier.spec.ts`).

The baseline ends at the first recent anchor. It shares that boundary point
with the recent window but shares no returns, so the move being detected cannot
retroactively turn its own baseline into a trend.

### Sorting

Rows are sorted in a fixed group order for display (this is **display
ordering, not a trade-quality score**):

1. `TRANSITION` → 2. `REVERSAL` → 3. `TREND` → 4. `OSCILLATING` → 5. `MIXED`
   → 6. `THIN` → 7. failed/no-data rows.

Within `TRANSITION`/`REVERSAL`/`TREND`, sort by absolute current normalized
drift descending. Within `OSCILLATING`, sort by reversal rate descending then
efficiency ascending. Symbol is the final tie-breaker.

## Output

`A+B` and `B+A` are the same relationship with inverted direction. When both
are supplied, Rank Pairs keeps the first orientation and reports how many
reciprocal duplicates were skipped. Self-pairs such as `A+A` contain no
relative-price information, so they are skipped and reported separately.

Each rendered row shows the combined label badge plus concise evidence:
annualized slope, volatility, efficiency, reversal rate, recent direction,
anchor count, and `asOf`. **Copy Results** emits the full scalar contract.

### Copy Results contract

The clipboard output is versioned `RANK_PAIRS_V2`. The header line is followed
by a column-name line and one pipe-delimited row per pair, in the same
deterministic display order as the rendered list. Columns:

```
RANK_PAIRS_V2
PAIR | STATUS | DIRECTION | STRUCTURE | LABEL | REASON | ERROR | RATIO_RET |
LOG_RET | ANN_SLOPE | ANN_VOL | NORM_DRIFT | PATH_EFF | REVERSAL_RATE |
HAS_RECENT | RECENT_DRIFT | RECENT_EFF | ENDPOINT_RATIO | IN_BAND | ANCHORS |
BARS | ELAPSED_DAYS | AS_OF
```

`STATUS` is one of `ok`, `no_data`, `failed`. `REASON` carries the classifier
reason code (`OK`, `INSUFFICIENT_ANCHORS`, `INVALID_TIME`, `NO_VALID_CLOSES`,
`ZERO_VARIANCE`); for `failed` rows `ERROR` carries the load error message.

### Diagnostics

Each run shows a performance line and emits one `rank_pairs.run_complete` debug
event (via `debugLogger`). Diagnostics separate dataset load/build,
classification, live DOM, progress, task yielding, sorting, and final DOM time;
they also include throughput, bars materialized, and cache deltas. No candles
and no per-pair events are logged.

For large universes, the browser renders and retains only the top 2,000 sorted
rows. After a completed run, the full scalar Copy Results rows are formatted
and written to IndexedDB in 1,000-line chunks; OHLCV is never stored in this
snapshot. The in-memory 124,000+ result array is then released.

The latest completed snapshot survives page reload. Opening Rank Pairs restores
its summary, performance diagnostics, mode, and bounded preview without loading
the full result. The complete text is materialized only when **Copy Results**
is clicked. A new snapshot replaces the previous generation only after all new
chunks commit, so an interrupted or quota-failed save leaves the prior
completed snapshot recoverable.

## Limitations

- **Lookahead bias:** a regime label is measured over a multiyear historical
  window. Ranking pairs by a label and then backtesting over the same period is
  lookahead-biased. The tab's hint banner states this.
- **Non-stationarity:** the latest candle anchors the window, so labels can
  change between runs. `asOf` exposes the source time.
- **Coverage:** assets failing the 33-anchor/960-day requirement remain `THIN`;
  there is no shorter-term fallback.
- **Thresholds are uncalibrated starting points.** They were chosen from the
  metric definitions, not fitted to labeled real charts. See Validation status.

## Validation status

Automated (passing): metric definitions, null/reason behavior, anchor
extraction, reciprocal-pair invariants, gap-correctness (duration-weighted
returns keep slope stable when interior anchors are missing), classification
precedence and boundary conditions, deterministic sorting, and the
summary/copy/failure contracts. Covered by `tests/rank-pairs-regime-classifier.spec.ts`
and `tests/rank-pairs-service.spec.ts`.

**Open — requires user input or a live environment (not blocking for code
correctness, blocking for production trust):**

- **Real-chart threshold calibration.** The thresholds need to be checked
  against user-labeled known Uptrend / Chop / Downtrend / Reversal charts.
  This is a prerequisite the plan calls out (§Phase 2 dependencies) and cannot
  be settled by synthetic fixtures, which are built around the thresholds by
  construction.
- **Manual smoke matrix** — crypto ratios at `30m`/`4h`/`1d`, IBKR stock ratios
  at `4h`/`1d`, a pair and its reciprocal, and known regime examples — requires
  the same live environment.

Until calibration lands, treat the labels as a research surface whose
*structure* (direction vs. structure split, calendar anchoring, precedence) is
sound but whose *thresholds* may need adjustment. Changing a threshold is a
named-constant edit in `pair-regime-classifier.ts` plus a fixture/boundary-test
update.

## Relationship to the old scorer

The previous Rank Pairs scorer (`relative-strength-score.ts`, removed) produced
`STRONG_BASE` / `SOLID_BASE` / `FLAT` / `WEAK_BASE` / `THIN` verdicts from
first-to-last return with continuous-market annualization. **Those V1 labels
are not equivalent to V2 regimes** — V1 encoded only directional magnitude over
the fetched window, while V2 separates direction from structure with
calendar-anchored metrics. There is no V1↔V2 mapping; V2 remains the Full
History production path.

## Latest 200 Bars mode

The selectable **Latest 200 Bars** mode is a separate descriptive chart-shape
classifier. It normalizes timestamps and closes, deduplicates timestamps,
sorts chronologically, and uses exactly the latest 200 valid ratio bars. It
does not reuse or change the Full History calendar anchors or thresholds.

Its mutually exclusive groups are:

- `TYPE A` Stable Range
- `TYPE B` Expanding Range
- `TYPE C` Compressing Range
- `TYPE D` Base Trend
- `TYPE E` Quote Trend
- `TYPE F` Base/Quote Breakout
- `TYPE G` Base/Quote Reversal
- `TYPE H` Level Shift
- `TYPE I` Mixed/Noisy
- `TYPE J` Thin

The first 150 bars form the baseline and the latest 50 bars describe the
recent segment for breakout/reversal decisions. The first and last 50-bar
segments provide range-width and level-shift evidence. This remains
classification only: it emits no opportunity, quality, entry, or profitability
score.

Recent Copy Results uses its own versioned scalar contract,
`RANK_PAIRS_RECENT_200_V1`, so the existing `RANK_PAIRS_V2` Full History
contract remains unchanged.

## What Rank Pairs does NOT change

- Full History synthetic candle or Batch loader behavior, caches, or limits.
- Finder, Batch Backtest, Stability Mine, strategies, or saved Batch templates.
- Server routes, workers, or persisted settings. Rank Pairs uses its own
  browser IndexedDB solely for the latest completed scalar result snapshot.
- No OHLCV array crosses a network boundary or remains in Rank Pairs results —
  only scalar classification results are retained after each pair is processed.
