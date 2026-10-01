# Trade Ledger Archive Format

This guide records the format of existing trade-ledger archives. The current Batch
application does not create new archives. Existing folders remain readable by the
offline replay checker and Pair Selection.

## Run folder layout

```
<folder>/<yyyy-MM-dd_HHmm>_<runId>/
    provenance.json      # run config snapshot + replay contract (run start)
    ledger.jsonl         # one line per entry signal, appended incrementally per pair
    signal-ranks.jsonl   # cross-sectional rank per signal (run end)
    summary.json         # totals, per-pair suppression rates, completeness (run end)
```

These are historical artifacts. The offline checker and Pair Selection continue to
read compatible archived folders.
The current Batch run route does not write ledger files.

### provenance.json

Run-level snapshot: `ledgerVersion`, `featureVersion`, `ledgerHorizons`, `ledgerWindow`,
`runId`, `startedAt`,
`interval`, `strategyKey`, `strategyParams`, full `backtestSettings` +
`capitalSettings`, `engineMode`, `executionModel`, `tradeDirection`, `riskMode`,
`fees` (`commissionPercent`, `slippageBps`), `pairCount`, `symbols`, and the
**replay contract**:

```json
"replay": {
  "replayEligible": true,
  "replayBlockers": [],
  "maxOpenTrades": 1 | "unlimited",
  "cooldownBars": 0,
  "executionModel": "next_open",
  "tradeDirection": "long",
  "allowSameBarExit": false,
  "disableSignalExits": true,
  "slippageRate": 0.0005,
  "commissionRate": 0
}
```

The run-level `ledgerHorizons` field is an array of positive whole-bar counts,
for example `[24]`.

### Replay eligibility guard

Archived `replay` metadata records whether the source run supported an as-if
replay. Admission rules change which trades exist, so per-candidate outcomes
must not depend on prior accepted-trade history. Archives record
`replayEligible: false` (with reasons) for:

- **Adaptive take-profit** â€” any `takeProfitMode` other than `fixed`
  (`adaptive_take_profit:<mode>`).
- **Path exits** â€” `pathExitEnabled` with a mode other than `off` (`path_exit:<mode>`).
- **Partial take-profit** â€” `partialTakeProfitAtR > 0` (an as-if trade can have only
  one exit).
- **Win-streak stop-loss** â€” `riskWinStreakStopLossEnabled` (depends on prior accepted
  trades by definition).
- **Dynamic sizing** â€” `capitalSettings.sizingMode` other than `percent`/`fixed`
  (allocation failures change which entries the engine takes).
- **Regime entry filters** â€” `marketMode`, `trendEmaPeriod`, `atrPercentMin/Max`,
  `adxMin/Max`: the engine drops entries inside `prepareSignals`, so the ledger's
  candidate set would differ from the engine's.
- **Both-direction reversals** â€” both-like `tradeDirection` with
  `disableSignalExits` off (opposite signals flip positions).

**Not blockers** (position-state rules the replay state machine handles itself):
`riskCooldownEnabled`/`riskCooldownBars` (post-exit entry cooldown) and
`maxOpenTrades` (open-slot cap; the engine's unlimited overlap resolves to
`Infinity`, preserved as `"unlimited"` in provenance). Fixed price levels (TP/SL),
ATR/trailing stops, break-even, bar-count holds (`riskMaxHoldBars`, `timeStopBars`),
and minimum-hold are MODELED, not blocked â€” the as-if walk reuses the engine's own
exported per-bar handlers, so they stay eligible.

The checker REFUSES replay with a clear message on ineligible folders.

### ledger.jsonl â€” one JSON object per line, per ENTRY SIGNAL

| Group   | Fields |
|---------|--------|
| Identity  | `pair`, canonical `baseSymbol` / `quoteSymbol`, `direction` (`long`\|`short`), `ledgerVersion` |
| Entry     | `signalTime` (unix s of the decision bar), `signalBarIndex`, `fillTime`, `fillPrice`, `executed`, `notExecutedReason` |
| Features  | `feat_entryRangePosition`, `feat_atrPct`, `feat_return20`, `feat_gapPct`, `feat_dow`, `feat_hour`, `feat_pairWinRatePrior`, `feat_pairTradesPrior`, `feat_barsSincePairLastFire`, `feat_pairSpreadVolatility20`, `feat_legVolatilityRatio20`, `feat_rank`, `feat_candidatesAtTime` |
| Horizon   | `horizons[H]: { entryTimeSec, entryPrice, exitTimeSec, exitPrice, pnlPercent, status }` for each configured H; `status` is `"ok"` or `"right_censored"` |
| As-if     | `asIf: { fillTime, fillPrice, exitTime, exitPrice, pnlPercent, barsHeld, exitReason } \| null`, `asIfReason` (`"right_censored"` \| `"replay_ineligible"` \| `null`) |
| Outcome   | `exitTime`, `exitPrice`, `pnlPercent`, `fees`, `exitReason` â€” **executed rows ONLY** (the keys are absent otherwise) |

- Signals are sorted by DECISION time before rows are built (trailing per-pair
  statistics follow decision order), and duplicate same-direction signals on one
  decision bar collapse deterministically â€” first wins, counted in
  `summary.duplicateSignalsCollapsed` (signal identity: `(pair, signalBarIndex,
  direction)`).
- Entry semantics mirror the engine: entry candidates = `allowsSignalAsEntry` under
  the resolved tradeDirection (`exitOnly` signals are never entries); fill =
  `getExecutionShift` + `resolveExecutionPrice` (the `prepareSignals` execution
  shift); slippage applied exactly like `buildPositionFromSignal`.
- Signals are matched to executed trades by direction + fill time + entry price
  within the run's slippage tolerance. `notExecutedReason` categories (all counted,
  never silent drops): `position_open`, `cooldown` (post-exit entry cooldown blocks
  the fill bar), `match_missing` (flat + unblocked but no trade matched â€” a matching
  failure), `no_fill_bar`, `engine_skip`.
- `asIf` is null ONLY when right-censored (no fill bar near the data end â€” the engine
  drops those entries too) or when the run is replay-ineligible
  (`asIfReason: "replay_ineligible"`). Never zero-filled, never a substituted exit.

### Fixed-horizon outcomes (v3)

Each row also carries the configured `ledgerHorizons` (default `[24]`) under
`horizons`. These outcomes are the pair spread's fixed-horizon judging values for
pair selection; they match the coordinator's per-asset outcome semantics instead
of following the frozen strategy's signal-exit or max-hold path. The `asIf` column
stays available for the legacy offline replay loop.

The alignment is exact: the entry bar is the row's fill bar (`signal_close` offset
0, `next_open`/`next_close` offset 1 from the signal bar), and `H` means the close
of bar `fillBarIndex + H`. `entryPrice` is the fill bar open. Long return is
`exitPrice / entryPrice - 1`; short return is `1 - exitPrice / entryPrice`.
When that exit bar does not exist, the outcome is `status: "right_censored"` with
`pnlPercent: null` and no fabricated last-bar exit price.

The pair-selection checker requires `ledgerVersion: 3` and reads the selected H
from `provenance.ledgerHorizons`; pass an optional third CLI argument to name a
different configured horizon. A horizon absent from that provenance is refused.

### As-if outcomes (archived field)

Historical rows may include `asIf` outcomes and an `asIfReason`. The offline
checker uses those recorded values to replay archived candidate selections;
this repository no longer produces new trade-ledger rows.

### Feature definitions (all causal â€” bars at or before the signal bar only)

Bump `TRADE_LEDGER_FEATURE_VERSION` whenever the archived feature set changes
(v3 = 3; the checker remains able to read v2 folders).

- `feat_entryRangePosition` â€” signal bar's close located within the PRIOR bar's
  `[low, high]` range, percent; null when the prior range is zero or `i < 1`.
- `feat_atrPct` â€” Wilder ATR with FIXED period 14 at the signal bar, divided by the
  signal bar close Ã— 100. Independent of the user's backtest ATR settings.
- `feat_return20` â€” `(close[i] âˆ’ close[iâˆ’20]) / close[iâˆ’20] Ã— 100`; null before bar 20.
- `feat_gapPct` â€” `(open[i] âˆ’ close[iâˆ’1]) / close[iâˆ’1] Ã— 100`; null at `i < 1`.
- `feat_dow` / `feat_hour` â€” UTC day-of-week (0 = Sunday) and hour of the signal bar.
- `feat_pairWinRatePrior` â€” trailing win rate (`pnlPercent > 0`) of THIS pair's
  strictly earlier executed trades within this run; null until â‰¥ 5 priors.
  `feat_pairTradesPrior` â€” the count of those trades.
- `feat_barsSincePairLastFire` â€” `signalBarIndex` minus the signal bar index of
  this same pair's previous signal in the run; null on the pair's first signal.
- `feat_pairSpreadVolatility20` â€” population standard deviation (divide by `N`)
  of the twenty one-bar percent changes
  `(close[k] âˆ’ close[kâˆ’1]) / close[kâˆ’1] Ã— 100` for `k = iâˆ’20 .. iâˆ’1`, where `i`
  is the signal bar index. All changes end strictly before the signal bar; null
  during warm-up (`i < 20` or when a required close is unavailable/non-positive).
- `feat_legVolatilityRatio20` â€” the same twenty-change population standard
  deviation on BASE closes divided by the same value on QUOTE closes, aligned
  to the pair bar timestamps. Null when aligned leg series are unavailable,
  fewer than twenty aligned observations exist, a required close is
  non-positive, or QUOTE volatility is zero.
- `feat_rank` / `feat_candidatesAtTime` â€” null in the ledger; filled by the checker
  from `signal-ranks.jsonl`.

The v3 `baseSymbol` and `quoteSymbol` columns are the canonical BASE and QUOTE
leg symbols from the run's pair definition. They are supplied by the loader/run
context, not inferred from a derived chart symbol. Warm-up or unavailable
features are always `null`, never zero. If a feature cannot be made causal, it
is dropped rather than approximated.

### signal-ranks.jsonl (cross-sectional rank pass)

Bounded `(signalTime â†’ distinct pairs)` tuples â€” interned pair strings in a per-time
`Set` (no repeated membership scans inside large same-timestamp buckets), no candle
data. One line per distinct `(signalTime, pair)`:
`{ signalTime, pair, rank, candidatesAtTime }` â€” `rank` is the pair's 1-based
position among the distinct pairs signaling at that timestamp, ordered ascending by
pair symbol (deterministic; there is no score at signal time). The checker joins on
`(signalTime, pair)`.

### summary.json

`ledgerWindow`, `totals` (`pairs`, `signals`, `executed`, `notExecuted`), overall `suppressionRate`,
`rightCensored`, `duplicateSignalsCollapsed`, the W4 **pair accounting** block,
`perPairSuppression` (all pairs with rows), `topSuppressedPairs` (top 20 by
suppression rate), `cancelled`, and `ledgerComplete` / `failedWrites` / `lastError`.

**Pair accounting (W4).** `provenance.pairCount` stays "submitted"; `summary.json`
carries the explicit split so a mismatch is never ambiguous:

- `submittedPairs` â€” pairs in the request (= `provenance.pairCount`).
- `loadedPairs` â€” pairs whose dataset loaded and ran; `submittedPairs âˆ’ loadedPairs`
  = pairs that failed to load/run (their names ride the run's `done` event totals and
  logs).
- `rowBearingPairs` â€” pairs with at least one ledger row (= `totals.pairs`).
- `emptyPairs` â€” loaded pairs with zero entry signals (`loadedPairs âˆ’
  rowBearingPairs`).
- `failedPairs` â€” pair identities whose rows were DROPPED by a failed append (W2);
  empty on a clean run.

The source snapshot retains full loaded bars and full engine trade records for every
captured pair. Its `entries.jsonl.gz` partition contains only the recorded, in-window
ledger rows, including their contiguous ledger ordinals. For a window with `fromSec`,
`entries-warmup.jsonl.gz` separately retains accepted pre-window entries as
`[signalBarIndex, direction, signalTimeSec]`; these records have no ledger ordinals,
outcome fields, or ledger-row binding. Feature generation folds them into strictly
prior fire/inter-fire history, while each feature's observation count remains the
support of its declared input window. A windowed folder has the same pair-selection
capabilities as any other compatible folder; the checker's optional --from / --to
controls remain available.

## Checker (replay mode)

```
..\..\..\node_modules\.bin\esno scripts/trade-ledger-checker.ts <ledgerFolder> <ruleFile.ts> [--allow-incomplete]
```

- `<ledgerFolder>` is a per-run folder containing `ledger.jsonl` + `provenance.json` +
  `summary.json`.
- `<ruleFile.ts>` default-exports `(row) => boolean` and may read ONLY identity/entry
  fields and `feat_*` fields.
- **Refusals (fail loud, never fake):** unsupported ledger versions require a compatible
  archived run; `replayEligible: false` reports the blocker reasons; missing
  `provenance.json`/`ledger.jsonl` produces explicit errors; and incomplete ledgers
  report the dropped `failedPairs`. `--allow-incomplete` overrides only the
  incomplete-ledger refusal, and the report keeps a loud warning banner.- **Streaming loader:** JSONL files are read via a chunked read stream + readline
  (CRLF, empty lines, missing trailing newline, UTF-8 bullet pair names all handled);
  a 2M-row ledger is never materialized as one Buffer. Parsed rows are still retained
  in memory (replay needs them); true row-streaming replay is out of scope. Practical
  boundary, measured with `scripts/bench-trade-ledger-scale.ts` on a synthetic
  2,000,000-row / 500-pair folder (measured during earlier validation): ~10s load +
  ~19s replay/report (28.9s total) at a ~1.35 GB `heapUsed` peak (~3.25 GB RSS) under
  an 8 GB heap â€” i.e. roughly **5s load + 10s replay and ~0.7 GB heap per million
  rows**.

**Anti-leakage contract.** The rule receives the row wrapped in a Proxy whose
`get`, `has`, `ownKeys`, and `getOwnPropertyDescriptor` traps are ALL guarded: property
reads and `in` probes of forbidden fields throw, and field enumeration
(`Object.keys`, `Object.entries`, spread `{...row}`, `JSON.stringify`) throws
unconditionally. Sealed fields: `exitTime`, `exitPrice`, `pnlPercent`, `fees`,
`exitReason`, `asIf`, `asIfReason`, plus `executed`/`notExecutedReason` â€” conditioning
on the ORIGINAL run's survivorship is lookahead for a rule meant to run live.
The v3 `horizons` field is sealed from legacy offline checker rules as well; pair-selection
reads it through its separate outcome harness.

**Replay semantics.** Per pair (pairs are independent in the engine â€” there is
deliberately NO global cross-pair capital replay): sort candidates by decision time;
the rule is applied BEFORE ordering; a candidate is admitted when an open slot is
free (`maxOpenTrades`), the post-exit cooldown has elapsed, and the rule passes; an
admitted trade keeps its slot busy until its as-if exit bar and arms the cooldown.
Rejected candidates occupy nothing. Right-censored candidates are counted as blocked.

**Report** (stable, deterministic):

- Candidates total / admitted / rejectedByRule / blocked / rightCensored, per pair
  and overall.
- `kept` percent over ALL candidates.
- **IS slice**: first 60% of the folder's GLOBAL calendar time range (split by time,
  never by trade count, never per pair; computed over every row's `signalTime`).
  Admitted trades' mean/median `pnlPercent` and hit rate; compounded total return and
  max drawdown are printed on a separate "scale-dependent (compounded)" line.
- **HOLDOUT slice** (last 40%): printed but labeled "sealed - finalists only".
- **Random control**: 200 seeded random replay filters (base seed 42, deterministic).
  Each control's keep-probability is calibrated in TWO DETERMINISTIC PASSES to admit
  approximately the rule's admitted count (pass 1 replays at `p0 = target /
  candidates`, pass 2 replays at the scaled `p`; control k is seeded `42 + k`), then
  replayed through the SAME state machine. The PRIMARY rule-vs-control comparison is
  PER-TRADE: mean and median `pnlPercent` deltas per slice (IS and holdout), rule
  minus the control's matching slice stat averaged across controls. Compounded total
  return and max drawdown explode with per-trade means (compounding multiplies
  variance), so they are demoted to lines explicitly labeled "scale-dependent
  (compounded)" and shown for information only; the report footer states this.

## Tests

- `tests/trade-ledger-checker.spec.ts` covers archived-format replay, rule safety,
  controls, ranks, incomplete archives, and report values.
