# Trade Ledger (Batch rule-mining export, v2)

The Batch "Save trade ledger" toggle exports a point-in-time trade ledger while a
server-side Batch run executes. The research workflow it serves: a winning strategy is
FIXED (found via a prior Batch run), and the next phase mines a rule for WHICH entry
signals to take. To test hundreds of candidate rules without ever re-running a
backtest, the run writes one ledger row per ENTRY SIGNAL — each with an **as-if
outcome** (the trade that WOULD have resulted if entered, computed with the engine's
own math) — and `scripts/trade-ledger-checker.ts` REPLAYS admission rules offline in
seconds.

One row per entry signal (not per completed trade) matters because a signal suppressed
by an open position becomes eligible once a filter removes the earlier trade. Scoring
rules only on the original run's executed rows would judge rules on survivors, not
candidates — the replay checker replaced that approach entirely.

## Batch menu control

- **Save trade ledger** (`batchBacktestTradeLedgerToggle`, default OFF) and **Folder**
  (`batchBacktestTradeLedgerFolder`, default `archive/mining-ledger`) live in the Batch
  tab, under the Balanced Generator. The control requires **server-side mode** (the
  Vite dev/preview server), which is Batch's only execution path. The folder is
  resolved relative to the app root (`server.config.root`).
- Both values persist across reloads via `lib/persisted-json.ts`
  (`playground_batch_backtest_trade_ledger`, schema `batch_backtest.trade_ledger`, v1).
- The request-body field is built by `buildBatchRunLedgerBodyField`
  (`lib/batch-backtest/trade-ledger-wire.ts`, dependency-free so the lazy browser chunk
  does not import the engine graph): `{}` when OFF, `{ tradeLedger: { enabled: true,
  folder } }` when ON — locked by an HTTP-level route test plus a wire unit test.
- These are BATCH-RUN options, deliberately **not** registered in
  `BACKTEST_SETTINGS_DOM_CONTRACTS`: that contract is round-tripped wholesale by
  `lib/settings-manager.ts` into engine settings / `AppSettings.backtestSettings`, and
  its `"string"` parser uppercases values, which would corrupt the folder path. The ids
  live in the batch feature-local DOM contract
  (`BATCH_BACKTEST_REQUIRED_IDS` in `lib/batch-backtest/batch-backtest-dom.ts`), which
  `tests/feature-dom-contracts.spec.ts` enforces against the partial like every other
  Batch id.

## Run folder layout

```
<folder>/<yyyy-MM-dd_HHmm>_<runId>/
    provenance.json      # run config snapshot + replay contract (run start)
    ledger.jsonl         # one line per entry signal, appended incrementally per pair
    signal-ranks.jsonl   # cross-sectional rank per signal (run end)
    summary.json         # totals, per-pair suppression rates, completeness (run end)
```

**The ledger is a pure side artifact.** Rows, trades, metrics, and stream events are
**identical minus wall-clock fields** (timings, cache statistics) with the toggle ON vs
OFF (locked at `processRunBatch` level by `tests/trade-ledger-exporter.spec.ts`, and at
HTTP level by a `POST /api/batch-backtest/run` route test asserting identical stream
payloads and the body-field neutrality). A ledger write failure never fails the batch
run: it is recorded in `summary.json` (`ledgerComplete: false`, `failedWrites`,
`failedPairs` — the pair identities whose rows were dropped), appended to the run's
terminal status line ("trade ledger incomplete …"), and logged via `debugLogger`
(`batch.server.ledger_*` events). Ledger appends carry a bounded retry: on
`EBUSY`/`EPERM`/`ESTALE` only, up to 3 total attempts with a 50ms/200ms backoff; after
the final failure the run continues with the loud non-fatal recording above. Writes
ride the existing awaited `onSymbolComplete` path — one incremental append per pair;
the per-pair as-if model is streaming state that dies with the callback, never a
global accumulation (audit F2 shape). No new HTTP routes are added (audit F1). The
plugin (`vite.config.ts` bundle) only imports leaf modules
(`trade-ledger-exporter.ts`, `trade-ledger-asif.ts`), which reach nothing
browser-bound.

### provenance.json

Run-level snapshot: `ledgerVersion`, `featureVersion`, `runId`, `startedAt`,
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

### Replay eligibility guard

`evaluateReplayEligibility` (`lib/batch-backtest/trade-ledger-asif.ts`) evaluates the
run's executor-resolved settings. Admission rules change WHICH trades exist, so
per-candidate outcomes must not depend on prior accepted-trade history. The guard
records `replayEligible: false` (with reasons) for:

- **Adaptive take-profit** — any `takeProfitMode` other than `fixed`
  (`adaptive_take_profit:<mode>`).
- **Path exits** — `pathExitEnabled` with a mode other than `off` (`path_exit:<mode>`).
- **Partial take-profit** — `partialTakeProfitAtR > 0` (an as-if trade can have only
  one exit).
- **Win-streak stop-loss** — `riskWinStreakStopLossEnabled` (depends on prior accepted
  trades by definition).
- **Dynamic sizing** — `capitalSettings.sizingMode` other than `percent`/`fixed`
  (allocation failures change which entries the engine takes).
- **Regime entry filters** — `marketMode`, `trendEmaPeriod`, `atrPercentMin/Max`,
  `adxMin/Max`: the engine drops entries inside `prepareSignals`, so the ledger's
  candidate set would differ from the engine's.
- **Both-direction reversals** — both-like `tradeDirection` with
  `disableSignalExits` off (opposite signals flip positions).

**Not blockers** (position-state rules the replay state machine handles itself):
`riskCooldownEnabled`/`riskCooldownBars` (post-exit entry cooldown) and
`maxOpenTrades` (open-slot cap; the engine's unlimited overlap resolves to
`Infinity`, preserved as `"unlimited"` in provenance). Fixed price levels (TP/SL),
ATR/trailing stops, break-even, bar-count holds (`riskMaxHoldBars`, `timeStopBars`),
and minimum-hold are MODELED, not blocked — the as-if walk reuses the engine's own
exported per-bar handlers, so they stay eligible.

The checker REFUSES replay with a clear message on ineligible folders.

### ledger.jsonl — one JSON object per line, per ENTRY SIGNAL

| Group   | Fields |
|---------|--------|
| Identity  | `pair`, `direction` (`long`\|`short`), `ledgerVersion` |
| Entry     | `signalTime` (unix s of the decision bar), `signalBarIndex`, `fillTime`, `fillPrice`, `executed`, `notExecutedReason` |
| Features  | `feat_entryRangePosition`, `feat_atrPct`, `feat_return20`, `feat_gapPct`, `feat_dow`, `feat_hour`, `feat_pairWinRatePrior`, `feat_pairTradesPrior`, `feat_rank`, `feat_candidatesAtTime` |
| As-if     | `asIf: { fillTime, fillPrice, exitTime, exitPrice, pnlPercent, barsHeld, exitReason } \| null`, `asIfReason` (`"right_censored"` \| `"replay_ineligible"` \| `null`) |
| Outcome   | `exitTime`, `exitPrice`, `pnlPercent`, `fees`, `exitReason` — **executed rows ONLY** (the keys are absent otherwise) |

- Signals are sorted by DECISION time before rows are built (trailing per-pair
  statistics follow decision order), and duplicate same-direction signals on one
  decision bar collapse deterministically — first wins, counted in
  `summary.duplicateSignalsCollapsed` (signal identity: `(pair, signalBarIndex,
  direction)`).
- Entry semantics mirror the engine: entry candidates = `allowsSignalAsEntry` under
  the resolved tradeDirection (`exitOnly` signals are never entries); fill =
  `getExecutionShift` + `resolveExecutionPrice` (the `prepareSignals` execution
  shift); slippage applied exactly like `buildPositionFromSignal`.
- Signals are matched to executed trades by direction + fill time + entry price
  within the run's slippage tolerance. `notExecutedReason` categories (all counted,
  never silent drops): `position_open`, `cooldown` (post-exit entry cooldown blocks
  the fill bar), `match_missing` (flat + unblocked but no trade matched — a matching
  failure), `no_fill_bar`, `engine_skip`.
- `asIf` is null ONLY when right-censored (no fill bar near the data end — the engine
  drops those entries too) or when the run is replay-ineligible
  (`asIfReason: "replay_ineligible"`). Never zero-filled, never a substituted exit.

### As-if outcomes: engine math, no parallel exit engine

The as-if walk (`resolveAsIfOutcome` in `trade-ledger-asif.ts`) reuses the engine's
own code at every step:

- Entry levels (`stopLossPrice`, `takeProfitPrice`, `riskPerShare`,
  `partialTargetPrice`) come from `resolveInitialExitLevels` — the arming math
  extracted from `position-builder.ts` (`buildPositionFromSignal` calls the SAME
  helper; there is one source for entry-level semantics).
- The exit walk calls the engine's exported per-bar handlers —
  `processPositionExits` (stop/TP/partial/path/min-hold/max-hold/time-stop fills) and
  `updatePositionState` (trailing stop, break-even, extreme price) — in the engine's
  per-bar order: open-only exits → signal exits → full exits → state update, with the
  same same-bar entry gate (`allowSameBarExit`).
- Signal exits come from the REAL merged exit path: `resolveExitStrategyOverrideSignals`
  (exported from `backtest-executor.ts` for exactly this purpose) + `mergeExitStrategySignals`
  + `prepareSignals`. There is no parallel exit resolution anywhere.
- pnl uses `calculateTradeExitDetails` — the engine's trade-close math, so as-if
  `pnlPercent` is identical to what a real trade at that entry would book
  (slippage on both sides + commission).
- End-of-data exits at the last bar's raw close, matching the engine's
  `end_of_data` trades.

Known approximations (documented, tested): an entry candidate at most one bar before
an admitted trade's exit bar is treated as blocked (the engine can sometimes re-enter
on the exit bar itself); entries whose sizing bar precedes the ATR window arm no
levels (ATR is null there for the engine as well).

### Feature definitions (all causal — bars at or before the signal bar only)

Bump `TRADE_LEDGER_FEATURE_VERSION` whenever the feature set changes (v2 = 2).

- `feat_entryRangePosition` — signal bar's close located within the PRIOR bar's
  `[low, high]` range, percent; null when the prior range is zero or `i < 1`.
- `feat_atrPct` — Wilder ATR with FIXED period 14 at the signal bar, divided by the
  signal bar close × 100. Independent of the user's backtest ATR settings.
- `feat_return20` — `(close[i] − close[i−20]) / close[i−20] × 100`; null before bar 20.
- `feat_gapPct` — `(open[i] − close[i−1]) / close[i−1] × 100`; null at `i < 1`.
- `feat_dow` / `feat_hour` — UTC day-of-week (0 = Sunday) and hour of the signal bar.
- `feat_pairWinRatePrior` — trailing win rate (`pnlPercent > 0`) of THIS pair's
  strictly earlier executed trades within this run; null until ≥ 5 priors.
  `feat_pairTradesPrior` — the count of those trades.
- `feat_rank` / `feat_candidatesAtTime` — null in the ledger; filled by the checker
  from `signal-ranks.jsonl`.

If a feature cannot be made causal, it is dropped rather than approximated.

### signal-ranks.jsonl (cross-sectional rank pass)

Bounded `(signalTime → distinct pairs)` tuples — interned pair strings in a per-time
`Set` (no repeated membership scans inside large same-timestamp buckets), no candle
data. One line per distinct `(signalTime, pair)`:
`{ signalTime, pair, rank, candidatesAtTime }` — `rank` is the pair's 1-based
position among the distinct pairs signaling at that timestamp, ordered ascending by
pair symbol (deterministic; there is no score at signal time). The checker joins on
`(signalTime, pair)`.

### summary.json

`totals` (`pairs`, `signals`, `executed`, `notExecuted`), overall `suppressionRate`,
`rightCensored`, `duplicateSignalsCollapsed`, the W4 **pair accounting** block,
`perPairSuppression` (all pairs with rows), `topSuppressedPairs` (top 20 by
suppression rate), `cancelled`, and `ledgerComplete` / `failedWrites` / `lastError`.

**Pair accounting (W4).** `provenance.pairCount` stays "submitted"; `summary.json`
carries the explicit split so a mismatch is never ambiguous:

- `submittedPairs` — pairs in the request (= `provenance.pairCount`).
- `loadedPairs` — pairs whose dataset loaded and ran; `submittedPairs − loadedPairs`
  = pairs that failed to load/run (their names ride the run's `done` event totals and
  logs).
- `rowBearingPairs` — pairs with at least one ledger row (= `totals.pairs`).
- `emptyPairs` — loaded pairs with zero entry signals (`loadedPairs −
  rowBearingPairs`).
- `failedPairs` — pair identities whose rows were DROPPED by a failed append (W2);
  empty on a clean run.

## Checker (replay mode)

```
..\..\..\node_modules\.bin\esno scripts/trade-ledger-checker.ts <ledgerFolder> <ruleFile.ts> [--allow-incomplete]
```

- `<ledgerFolder>` is a per-run folder containing `ledger.jsonl` + `provenance.json` +
  `summary.json`.
- `<ruleFile.ts>` default-exports `(row) => boolean` and may read ONLY identity/entry
  fields and `feat_*` fields.
- **Refusals (fail loud, never fake):** v1 folders → "ledger v1 — re-run the batch to
  regenerate"; `replayEligible: false` → the blocker reasons; missing
  `provenance.json`/`ledger.jsonl` → explicit errors; and — audit W1 — **incomplete
  ledgers**: a missing `summary.json`, an unsupported `ledgerVersion`,
  `ledgerComplete: false`, or `failedWrites > 0` is refused with the dropped
  `failedPairs` listed. `--allow-incomplete` overrides that ONE refusal, and the
  resulting report carries a loud `!! INCOMPLETE LEDGER …` banner so an overridden run
  can never be mistaken for a clean one later.
- **Streaming loader:** JSONL files are read via a chunked read stream + readline
  (CRLF, empty lines, missing trailing newline, UTF-8 bullet pair names all handled);
  a 2M-row ledger is never materialized as one Buffer. Parsed rows are still retained
  in memory (replay needs them); true row-streaming replay is out of scope. Practical
  boundary, measured with `scripts/bench-trade-ledger-scale.ts` on a synthetic
  2,000,000-row / 500-pair folder (regenerate + measure any time): ~10s load +
  ~19s replay/report (28.9s total) at a ~1.35 GB `heapUsed` peak (~3.25 GB RSS) under
  an 8 GB heap — i.e. roughly **5s load + 10s replay and ~0.7 GB heap per million
  rows**.

**Anti-leakage contract.** The rule receives the row wrapped in a Proxy whose
`get`, `has`, `ownKeys`, and `getOwnPropertyDescriptor` traps are ALL guarded: property
reads and `in` probes of forbidden fields throw, and field enumeration
(`Object.keys`, `Object.entries`, spread `{...row}`, `JSON.stringify`) throws
unconditionally. Sealed fields: `exitTime`, `exitPrice`, `pnlPercent`, `fees`,
`exitReason`, `asIf`, `asIfReason`, plus `executed`/`notExecutedReason` — conditioning
on the ORIGINAL run's survivorship is lookahead for a rule meant to run live.

**Replay semantics.** Per pair (pairs are independent in the engine — there is
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

## Discipline

1. **Invent rules on IS only.** The IS slice exists to generate and refine candidate
   rules. Look at the HOLDOUT numbers during mining and you have burned the holdout.
2. **Holdout is sealed for finalists.** Only rules that already survived IS scrutiny
   get a single holdout read, and every holdout read consumes trust — keep the count
   small and honest.
3. **Certify once, from raw data.** The finally-chosen strategy + rule must be
   re-run ONCE through the real engine from raw data — the rule applied live (its
   admissions change the trade sequence), not by re-scoring the ledger — as
   independent certification before any capital is exposed.
4. Replay assumes exits are history-independent; only mine on
   `replayEligible: true` folders.

## Tests

- `tests/trade-ledger-exporter.spec.ts` — v2 row schema + as-if outcomes (engine exit
  series, stop-out, end-of-data, same-bar gate, right-censoring), executed/notExecuted
  categories incl. cooldown + match_missing, duplicate collapse, slippage tolerance
  boundaries, unlimited `maxOpenTrades`, causal immunity (mutating bar i+1), fixed
  ATR(14), replay-eligibility guard list, writer files/ranks/summary + pair
  accounting, write-failure → `ledgerComplete: false` + `failedPairs`, bounded
  EBUSY/EPERM/ESTALE retry (fail-twice-then-succeed lands the row; always-fail
  records), toggle-off produces no folder, ON/OFF identical-minus-wall-clock
  results, setup failure visible in the run summary, request-body wire contract, W5
  completion-context forwarding + a child-process `--expose-gc` WeakRef collection
  check, and the HTTP-level `POST /run` route contract.
- `tests/trade-ledger-checker.spec.ts` — W1 proxy traps (get/has/ownKeys/descriptor,
  `Object.keys`, spread, `JSON.stringify`), replay semantics (accept-all, rule
  rejection frees the slot, busy/cooldown blocks, right-censored counting),
  IS/holdout split, deterministic calibrated random control, ranks join, v1 +
  ineligible refusals, incomplete-ledger refusals (missing summary /
  `ledgerComplete:false` / `failedWrites>0`), the `--allow-incomplete` banner,
  streaming JSONL edge cases (CRLF, empty lines, no trailing newline, UTF-8 bullet
  pairs), deterministic report values, and end-to-end anti-leakage enforcement.
