# Rank Pairs

Rank Pairs classifies the regime of each synthetic pair's ratio path. It is a
browser-only, lazy-initialized research tab (registered in `lib/app-bootstrap.ts`).

- Markup source: `html-partials/tab-rank-pairs.html`
- Structural DOM contract: `lib/rank-pairs/rank-pairs-dom.ts`
- Pure classifier: `lib/rank-pairs/pair-regime-classifier.ts`
- UI service: `lib/rank-pairs/rank-pairs-service.ts`
- Datasets: loaded through the shared Batch loader (`loadBatchDataset`) — the
  loader is the source of truth for synthetic-pair construction, aligned
  candles, interval aggregation, and caches. Rank Pairs changes none of that.

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
- `annualizedVolatility` — annualized stdev of 30-day periodic log returns
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
2. `REVERSAL` — full `|normalizedDrift|` ≥ 0.50 AND recent drift ≥ 0.75 in the
   opposite direction AND recent efficiency ≥ 0.40.
3. `TRANSITION` — full structure not trending AND recent `|normalizedDrift|` ≥
   0.75 AND recent efficiency ≥ 0.40.
4. `TREND` — full `|normalizedDrift|` ≥ 0.50 AND full efficiency ≥ 0.25.
5. `OSCILLATING` — endpoint inside the reciprocal 30% band AND full efficiency
   ≤ 0.20 AND 30-day reversal rate ≥ 0.50.
6. `MIXED` — valid history that meets none of the above.

All thresholds are named constants in `pair-regime-classifier.ts`. Changing any
threshold is a behavior change that requires fixture and boundary-test updates
(`tests/rank-pairs-regime-classifier.spec.ts`).

### Sorting

Rows are sorted in a fixed group order for display (this is **display
ordering, not a trade-quality score**):

1. `TRANSITION` → 2. `REVERSAL` → 3. `TREND` → 4. `OSCILLATING` → 5. `MIXED`
   → 6. `THIN` → 7. failed/no-data rows.

Within `TRANSITION`/`REVERSAL`/`TREND`, sort by absolute current normalized
drift descending. Within `OSCILLATING`, sort by reversal rate descending then
efficiency ascending. Symbol is the final tie-breaker.

## Output

Each rendered row shows the combined label badge plus concise evidence:
annualized slope, volatility, efficiency, reversal rate, recent direction,
anchor count, and `asOf`. **Copy Results** emits the full scalar contract.

### Copy Results contract

The clipboard output is versioned `RANK_PAIRS_V2`. The header line is followed
by a column-name line and one pipe-delimited row per pair, in the same
deterministic display order as the rendered list. Columns:

```
RANK_PAIRS_V2
PAIR | DIRECTION | STRUCTURE | LABEL | REASON | RATIO_RET | LOG_RET | ANN_SLOPE |
ANN_VOL | NORM_DRIFT | PATH_EFF | REVERSAL_RATE | HAS_RECENT | RECENT_DRIFT |
RECENT_EFF | ENDPOINT_RATIO | IN_BAND | ANCHORS | BARS | ELAPSED_DAYS | AS_OF
```

### Diagnostics

Each run emits one `rank_pairs.run_complete` debug event (via `debugLogger`)
with: `interval`, `classified` count, `failed` count, `cancelled` flag,
`elapsedMs`, `byDirection`, and `byStructure` count maps. No candles and no
per-pair events are logged.

## Limitations

- **Lookahead bias:** a regime label is measured over a multiyear historical
  window. Ranking pairs by a label and then backtesting over the same period is
  lookahead-biased. The tab's hint banner states this.
- **Non-stationarity:** the latest candle anchors the window, so labels can
  change between runs. `asOf` exposes the source time.
- **Coverage:** assets failing the 33-anchor/960-day requirement remain `THIN`;
  there is no shorter-term fallback.
- **Threshold calibration:** the initial thresholds are starting points and may
  need calibration against user-labeled real charts.

## Relationship to the old scorer

The previous Rank Pairs scorer (`relative-strength-score.ts`, removed) produced
`STRONG_BASE` / `SOLID_BASE` / `FLAT` / `WEAK_BASE` / `THIN` verdicts from
first-to-last return with continuous-market annualization. **Those V1 labels
are not equivalent to V2 regimes** — V1 encoded only directional magnitude over
the fetched window, while V2 separates direction from structure with
calendar-anchored metrics. There is no V1↔V2 mapping and no selectable mode;
the V2 classifier is the only production path.

## What Rank Pairs does NOT change

- Synthetic candle or Batch loader behavior, caches, or limits.
- Finder, Batch Backtest, Stability Mine, strategies, or saved Batch templates.
- Server routes, databases, workers, persistence, or persisted settings.
- No OHLCV array crosses a network boundary or remains in Rank Pairs results —
  only scalar classification results are retained after each pair is processed.
