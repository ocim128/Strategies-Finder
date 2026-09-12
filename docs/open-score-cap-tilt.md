# OPEN_SCORE USD cap-tilt weight (`capTiltWeight`) — technical plan

**Status: IMPLEMENTED — Phases 1–4 (standalone OPEN_SCORE USD rerun) and Phase 5 (TOP_MEAN Coordinator threading). Audited 2026-09-12: no defects found; typecheck + full suite (281 specs) green.**

## Motivation

The OPEN_SCORE USD replay scores every pair event as base +1 / quote −1 for a
long entry (inverse at exit; short pairs mirrored). The next experiment asks
whether **market-cap tilt** between the two legs carries selection information:

- `smallBase2x` — the base leg of a LONG pair is worth **+2** instead of +1
  when the base's market cap at entry is **lower** than the quote's.
- `largeBase2x` — same, when the base's cap at entry is **higher** than the
  quote's.

Quotes stay −1, short pairs stay ±1, and the positive pool is still
`rawScore > 0` — so the weighting can only change how candidates **rank**,
never who is a candidate. The experiment is run three times (off /
smallBase2x / largeBase2x) and the TOP_MEAN delta-vs-random lines are
compared across reports. Deliberately **not** in scope: new selector arms
(`TOP_MEAN_SMALL2X` etc.), cap-tilt diagnostics, and changes to any other
arm's semantics. If the experiment survives, a follow-up plan promotes it to
proper parallel-counter arms.

## Current architecture (verified)

- **Engine** — `lib/batch-backtest/batch-open-score-usd-replay-engine.ts`
  (pure leaf, no `lightweight-charts`, no disk I/O):
  - `RunOpenScoreUsdReplayOptions` (line 555) already takes plain scalars and
    injected callbacks (`onPhase`, `shouldStop`, `onPoolSnapshot`), so an
    injected cap lookup is an established shape.
  - Phase 1 reconstruction loop (line 1090): iterates artifacts
    (`artifact.baseAsset/quoteAsset` asset names, `artifact.baseSymbol/
    quoteSymbol` symbols — `BatchSyntheticPairArtifact`,
    `lib/batch-backtest/batch-synthetic-artifact.ts:31-32`), and per trade
    emits `ScoreDelta { timeSec, assetIndex, delta, isEntry }` (line 979):
    entry `sign` / `-sign` for base/quote (line 1117-1131), exit deltas are
    the exact inverse, skipped when `exitReason === "end_of_data"`.
  - Everything downstream (`rawScore`, `recentRawScore`, `entryFlow`,
    HHI, acceleration) accumulates `delta` magnitudes; `activePairCount`
    counts entries/exits and is magnitude-independent. A weighted delta
    therefore shifts all score-derived arms by design (accepted for this
    experiment — each run's report names its weighting, see report echo).
- **Server route** — `handleOpenScoreUsdRequest` /
  `processOpenScoreUsdReplay` in
  `lib/batch-backtest/batch-backtest-vite-plugin.ts` (~2109, ~2274). The
  handler validates `horizons` (length + value caps, `OPEN_SCORE_HORIZONS_MAX_LENGTH`)
  and `sampleFrom`/`sampleTo` (malformed date → 400), then calls
  `processOpenScoreUsdReplay(fingerprint, interval, writer, owner, horizons,
  sampleFromSec, sampleToSec, loadTargetDataset?)`, which builds the engine
  options object (line 2225) and calls `runOpenScoreUsdReplay` (line 2222).
  Artifacts are loaded one at a time via `loadStoredMineArtifact`; the
  plugin already extracts per-asset marked symbols into
  `markedSymbolByAsset` (line 2186).
- **Market-cap data on disk** — the implemented Download MarketCap feature
  (`docs/marketcap-download.md`) writes
  `price-data/ibkr/marketcap/<SYM>.csv` with header
  `time,close,shares_outstanding,market_cap` (daily rows, `time` = ISO UTC
  date of the 1d close, `market_cap` in USD) plus `catalog.json` and
  `.bak` files. Filenames are
  `encodeURIComponent(stripIbkrMarker(symbol).replace(/\//g, ""))`. Real
  data exists (S&P 500 backfilled).
- **Browser service** — `runOpenScoreUsdReplay()` in
  `lib/batch-backtest/batch-backtest-service.ts` (line 1928) reads
  `batchBacktestOpenScoreUsdHorizons` / `...From` / `...To` from the DOM and
  POSTs `{fingerprint, interval, horizons, sampleFrom?, sampleTo?}` to
  `/api/batch-backtest/open-score-usd` via `postBatchNdjson`.
- **DOM contract** — `lib/batch-backtest/batch-backtest-dom.ts` lists
  `batchBacktestOpenScoreUsd*` ids (lines 38-43, 101-106); the OPEN_SCORE
  USD section lives in `html-partials/tab-batch-backtest.html` (above the
  TOP_MEAN Coordinator section). `tests/feature-dom-contracts.spec.ts`
  verifies every registered id exists in the partials.
- **Report echo** — the engine's `config | interval=... horizons=[...]
  slippageRate=... commissionRate=...` line (engine ~line 3369) is where run
  configuration is already surfaced; `reportLines` render verbatim in the
  summary div and through both Copy paths.
- **TOP_MEAN Coordinator path** — "Run TOP_MEAN"
  (`sp500-top-mean-coordinator-engine.ts`) re-runs the same engine in its
  phase-3 replay. This was deferred in the first revision and is now **Phase 5**
  (below) — it is the user's primary workflow. Verified execution context:
  the replay runs IN-PROCESS in `TopMeanCoordinatorEngine` (the
  `TopMeanWorkerPool` only executes pair backtests), so threading is a
  request-field change, not worker plumbing.

## Design overview

One new enum request field, `capTiltWeight: "off" | "smallBase2x" |
"largeBase2x"` (default `"off"`), threaded browser → route → engine, plus a
small server-side market-cap reader that backs an injected
`lookupMarketCap(symbol, timeSec): number | null` callback.

**Weighting semantics (locked):**

- Applies ONLY to the base leg of LONG trades (`sign === 1`): entry delta
  `+w` instead of `+1`, where `w = 2` when the tilt condition matches.
- The tilt is classified **once per trade at entry** using caps at the entry
  timestamp, and the SAME `w` is applied to the exit delta (`−w`). This keeps
  `rawScore` returning to its prior level after every round-trip —
  re-classifying at exit (caps moved) would make every accumulator drift
  monotonically and corrupt the whole replay.
- Tilt condition: `lookupMarketCap(baseSymbol, entrySec)` and
  `lookupMarketCap(quoteSymbol, entrySec)` both non-null; `smallBase2x`
  requires `capBase < capQuote`, `largeBase2x` requires `capBase >
  capQuote`. Either lookup null (no cap data for that symbol or date) →
  `w = 1` (documented fallback: the run keeps full coverage and only differs
  from baseline where cap data exists).
- Everything else (quote −1, short pairs, `end_of_data` no-exit rule,
  positive pool, ties/digest tie-breaks) is untouched.

### Data flow

```
UI select (tab-batch-backtest.html, OPEN_SCORE USD section)
  → batch-backtest-service.ts runOpenScoreUsdReplay()  [body.capTiltWeight]
    → POST /api/batch-backtest/open-score-usd
      → handleOpenScoreUsdRequest: validate enum (400 on unknown)
      → processOpenScoreUsdReplay(..., capTiltWeight)
          if ≠ "off": build lookupMarketCap via
            lib/ibkr-data/marketcap-series-reader.ts   (NEW leaf)
            reads price-data/ibkr/marketcap/*.csv once per run
          → runOpenScoreUsdReplay(..., { capTiltWeight, lookupMarketCap })
              Phase 1 reconstruction: weight entry+exit deltas of qualifying
              long trades; echo the setting in reportLines
  → summary div + Copy paths render reportLines verbatim (unchanged plumbing)
```

### API contract

- `POST /api/batch-backtest/open-score-usd` body gains optional
  `capTiltWeight: string`. Absent/empty/`"off"` → baseline (byte-identical
  to today). Any other value not in the enum → `400` with the allowed
  values listed (mirrors the horizons validation style).
- `processOpenScoreUsdReplay` gains one trailing optional parameter
  `capTiltWeight: OpenScoreUsdCapTiltWeight = "off"` (after
  `loadTargetDataset`, so existing call sites and tests compile unchanged).
- `RunOpenScoreUsdReplayOptions` gains:
  - `capTiltWeight?: "smallBase2x" | "largeBase2x"` (absent = off), and
  - `lookupMarketCap?: (symbol: string, timeSec: number) => number | null`.
  The engine treats `capTiltWeight` set without `lookupMarketCap` as off
  (defensive; the route always passes both or neither).
- No changes to `OpenScoreUsdReplayResult`, stream event types, or any
  selector semantics. The ONLY visible difference is delta magnitudes feeding
  the existing arms, plus the config echo.

### Affected files

| File | Change |
| --- | --- |
| `lib/batch-backtest/batch-open-score-usd-replay-engine.ts` | option fields, weight logic in the Phase 1 trade loop, config echo |
| `lib/ibkr-data/marketcap-series-reader.ts` | **NEW leaf** — read + index marketcap CSVs, nearest-prior lookup |
| `lib/batch-backtest/batch-backtest-vite-plugin.ts` | body validation, `processOpenScoreUsdReplay` param, lookup construction, fatal on unavailable caps |
| `lib/batch-backtest/batch-backtest-service.ts` | read select, send `capTiltWeight` |
| `lib/batch-backtest/batch-backtest-dom.ts` + `html-partials/tab-batch-backtest.html` | one select id in the OPEN_SCORE USD section |
| `docs/batch-backtest-server-side.md` | document the field |

Import hygiene: `batch-backtest-vite-plugin.ts` is bundled by esbuild when
Vite bundles `vite.config.ts`. It currently imports nothing from
`lib/ibkr-data/` — keep it that way by making the reader a **self-contained
leaf** (node `fs`/`path` only; it strips the `•` marker and slashes itself
with a two-line replace rather than importing `stripIbkrMarker` from
`lib/local-daily-datasets.ts`). Never import
`lib/ibkr-data/ibkr-data-vite-plugin.ts` (the writer) from the Batch plugin.

### Reader contract (`marketcap-series-reader.ts`)

- `loadMarketCapLookup(dir: string): { lookup(symbol, timeSec): number | null; symbols: number }`.
- Reads every `*.csv` directly in `dir` (skip `*.bak`, skip `catalog.json`);
  skips malformed rows silently (the writer is the only producer); builds
  per-symbol sorted `(timeSec, marketCap)` arrays from the `time` and
  `market_cap` columns (`Date.parse(dateKey)/1000`; row order on disk is
  ascending but re-sort defensively).
- `lookup`: strip `•` and `/` from the symbol, exact file match only, then
  **nearest-prior** binary search (`timeSec' ≤ timeSec`) — cap rows are
  trading days while pair entries can be intraday or non-USD-calendar dates.
  No file or no row at/before the timestamp → `null`.
- Pure Node I/O, no imports beyond `node:fs`/`node:path` → safe for the
  esbuild config bundle and unit-testable against a temp dir.

### Security

- No new route, no new auth surface: the field rides the existing
  open-score-usd endpoint and its existing validation/tunnel policies.
- The new body field is a closed enum, validated before any work (a garbage
  value is a 400, never a silent baseline run).
- No credentials involved; marketcap CSVs are local research data.

### Performance

- Reader: ~500 small CSVs parsed once per rerun (~1–2 rows·10³ each) —
  well under a second; negligible next to artifact loading.
- Lookup: two O(log n) binary searches per long trade at reconstruction;
  even 10⁵ trades is noise.
- Memory: the index is a few MB (dropped after the engine call returns —
  build it inside `processOpenScoreUsdReplay`'s scope, not module-level).
- Replay runtime is unchanged otherwise; Phase 1 remains yield-bounded as
  today.

### Error handling

- `capTiltWeight` ≠ enum value → `400` before the owner/artifacts guards
  (mirrors audit-Finding-6 ordering: client input validation first).
- `capTiltWeight ≠ "off"` but `price-data/ibkr/marketcap/` is missing/empty →
  **fatal** stream event with an actionable message ("Download MarketCap in
  the IBKR Data tab first") — fail loud per AGENTS.md; do NOT silently run
  baseline and do NOT half-apply.
- Individual symbol without a cap file → per-trade fallback `w = 1`
  (documented, deterministic); no warnings spam.
- Empty/malformed rows skipped by the reader; a truncated CSV degrades to
  fewer known dates, never to wrong weights (unknown → 1).

### Rollback

- Remove the select + body field + option + reader import. No persisted
  state, no schema, no artifact, no catalog changes; retained artifacts and
  prior reports are unaffected. Reports are self-describing via the config
  echo, so old outputs remain interpretable.

## Implementation phases

### Phase 1 — engine weighting + report echo (pure, no I/O)

- **Objective**: the engine applies the ×2 base-leg weight for qualifying
  long trades and names the weighting in its report.
- **Tasks**:
  - Extend `RunOpenScoreUsdReplayOptions` with `capTiltWeight?` and
    `lookupMarketCap?` (contract above).
  - In the Phase 1 trade loop: compute `w` once per long trade from the
    entry-time caps; apply to entry AND exit deltas; short trades and quotes
    untouched. Resolve the symbol for the lookup from
    `artifact.baseSymbol` / `artifact.quoteSymbol` (fall back to the asset
    name when absent — the reader normalizes markers).
  - Extend the `config |` report line with `capTilt=off|smallBase2x|largeBase2x`
    and, when active, add one fixed line documenting the semantics
    ("base leg of long pairs ×2 when base cap < / > quote cap at entry;
    unknown caps weight 1").
- **Dependencies**: none.
- **Risks**: applying a different weight at exit than entry (drift bug) —
  the weight must be computed once and stamped on both deltas; weighting
  `entryFlow`/`recentRawScore`-derived arms shifts their numbers too —
  accepted, documented in the report line, not a bug.
- **Deliverables**: engine change + spec cases.
- **Validation**: extend `tests/batch-open-score-usd-replay-engine.spec.ts`
  (it already builds synthetic artifacts/trades in-process): (a) smallBase2x
  doubles the base entry delta when base cap < quote cap and the round-trip
  returns `rawScore` exactly to its prior value; (b) largeBase2x mirror;
  (c) missing cap for either leg → weight 1; (d) short pairs unaffected;
  (e) quote leg always ±1; (f) config echo present; (g) default options
  produce byte-identical output to the current engine (regression guard —
  run the existing spec unchanged).
- **Exit criteria**: all existing engine spec cases pass unmodified with
  `capTiltWeight` absent; new cases pass; `npm run typecheck` green.

### Phase 2 — marketcap reader leaf + plugin threading

- **Objective**: the route accepts and validates `capTiltWeight`, builds the
  lookup from disk, and fails loud when caps are required but unavailable.
- **Tasks**:
  - New `lib/ibkr-data/marketcap-series-reader.ts` per the reader contract.
  - `handleOpenScoreUsdRequest`: parse + validate the field (400 on unknown),
    thread through `processOpenScoreUsdReplay`'s new trailing param.
  - In `processOpenScoreUsdReplay`: when ≠ off, resolve
    `price-data/ibkr/marketcap` relative to the plugin's existing
    `APP_ROOT`/data-dir resolution, build the lookup once (before the engine
    call), pass `capTiltWeight` + `lookupMarketCap` into the engine options;
    missing/empty dir → `writer({ type: "fatal", ... })` with the actionable
    message.
- **Dependencies**: Phase 1.
- **Risks**: import-hygiene bundle trap — the reader must stay a
  dependency-free leaf (no `lib/local-daily-datasets.ts`, no
  `lib/ibkr-data/ibkr-data-vite-plugin.ts` imports); resolving the marketcap
  dir must reuse the same cwd-relative convention the IBKR plugin uses
  (`process.cwd()`-rooted `price-data/ibkr/marketcap`).
- **Deliverables**: reader module + plugin wiring.
- **Validation**: new `tests/marketcap-series-reader.spec.ts` (temp dir:
  parse, `.bak`/`catalog.json` skipped, nearest-prior lookup, marker/slash
  normalization, missing symbol → null); extend the open-score plugin spec
  coverage where the route handler is tested (400 on bad enum, fatal on
  missing dir with weight requested) following the existing
  `tests/batch-open-score-usd-*.spec.ts` patterns; `npm run typecheck`.
- **Exit criteria**: reader spec + route cases pass; dev server still starts
  (config bundle intact); baseline runs (`off`) unchanged.

### Phase 3 — UI select + service body

- **Objective**: the user can pick the weighting next to the existing
  OPEN_SCORE USD inputs and every rerun carries it.
- **Tasks**:
  - `html-partials/tab-batch-backtest.html`: add a select
    `batchBacktestOpenScoreUsdCapTilt` in the OPEN_SCORE USD fields row
    (options: Off / Small-base ×2 / Large-base ×2; tooltip with the one-line
    semantics), styled like the neighboring inputs.
  - `lib/batch-backtest/batch-backtest-dom.ts`: add the id to the required
    ids const + `createBatchBacktestDom()`.
  - `batch-backtest-service.ts` `runOpenScoreUsdReplay()`: read the select,
    include `capTiltWeight` in the POST body (omit when off, or send
    `"off"` — either is valid per contract; prefer omitting for clean
    bodies).
- **Dependencies**: Phase 2.
- **Risks**: forgetting the DOM contract entry —
  `tests/feature-dom-contracts.spec.ts` fails loudly by design.
- **Deliverables**: select + wiring.
- **Validation**: `npm run typecheck`;
  `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`;
  `..\..\..\node_modules\.bin\esno tests\batch-open-score-usd-replay-engine.spec.ts`.
- **Exit criteria**: contracts pass; selecting a weight and clicking the
  existing button produces a report whose config line names the active
  weighting; Off reproduces baseline output exactly.

### Phase 4 — docs + manual smoke

- **Objective**: the experiment is documented and verified end-to-end.
- **Tasks**:
  - Add a short `capTiltWeight` section to
    `docs/batch-backtest-server-side.md` (semantics, fallback, fatal
    condition, that all score-derived arms shift, and that the coordinator
    path does not support it yet).
  - Manual smoke: with retained artifacts, run Off / smallBase2x /
    largeBase2x; confirm the three reports' TOP_MEAN vs random delta lines
    are comparable and the config lines differ; force a fatal by renaming
    `price-data/ibkr/marketcap` away, then restore.
- **Dependencies**: Phases 1–3.
- **Deliverables**: docs + smoke notes.
- **Validation**: `npm run test` full suite.
- **Exit criteria**: three-run comparison workflow works from the UI alone;
  docs accurate; full suite green.

### Phase 5 — TOP_MEAN Coordinator threading ("Run TOP_MEAN")

- **Objective**: the coordinator's phase-3 OPEN_SCORE USD replay honors a
  coordinator-owned `capTiltWeight`, so the primary workflow produces
  weighted full-range and calendar-year reports without re-running pair
  backtests separately.
- **Verified context** (base the implementation on this):
  - `TopMeanCoordinatorRunRequest` (`sp500-top-mean-coordinator-engine.ts:70`)
    is the request contract; the browser builds it in
    `batch-backtest-service.ts` `runSp500TopMeanCoordinatorInner()` (~line
    2696, payload ~2745) from `batchBacktestSp500TopMean*` DOM ids.
  - `sp500-top-mean-vite-routes.ts` (~line 180) validates the request inline
    and via the shared leaf `validateTopMeanRequestLimits`
    (`sp500-top-mean-request-limits.ts`, own spec).
  - The replay closure `runReplayForWindow` (~line 752) builds engine options
    and is invoked for the FULL range (~line 815) and per calendar year
    (~line 863) — a single change there covers every pass.
  - The replay runs in-process; `TopMeanWorkerPool`/worker files need NO
    changes.
  - `runOpenScoreUsdReplay` already accepts `capTiltWeight` +
    `lookupMarketCap`, and the `config |` report line already echoes it —
    coordinator reports inherit the echo for free.
  - `loadMarketCapLookup` already exists as the dependency-free leaf
    `lib/ibkr-data/marketcap-series-reader.ts` (safe for the vite.config
    esbuild bundle; the coordinator engine is imported by the routes →
    `vite.config.ts`).
- **Tasks**:
  - `TopMeanCoordinatorRunRequest`: add
    `capTiltWeight?: "smallBase2x" | "largeBase2x"` (absent/`"off"` =
    baseline).
  - `sp500-top-mean-request-limits.ts`: validate the enum in
    `validateTopMeanRequestLimits` (absent/`"off"` passes through; any other
    non-enum string → error listing allowed values), following the existing
    horizons/workerCount validation style.
  - `sp500-top-mean-vite-routes.ts`: thread `limitCheck.value.capTiltWeight`
    into the request like `workerCount`/`maxPairs`.
  - Coordinator engine: when `this._request.capTiltWeight` is set, resolve
    `price-data/ibkr/marketcap` from `process.cwd()` (the same convention the
    Batch plugin uses), build the lookup ONCE per run via
    `loadMarketCapLookup` before the replay section, and pass
    `capTiltWeight` + `lookupMarketCap` inside `runReplayForWindow`'s options
    so both the full-range and calendar-year passes use it. Missing/empty
    dir → fail the run through the engine's EXISTING run-failure path with
    the same actionable message the standalone route uses ("Download
    MarketCap in the IBKR Data tab first") — no silent baseline fallback.
  - Provenance: `TopMeanRunManifest` (`compact-pair-artifact.ts`) gains
    `capTiltWeight` (written with the other manifest fields the engine
    already sets, e.g. `workerCount`) so saved archives/research ledgers are
    self-describing; check `sp500-top-mean-archive-log.ts`'s request
    serialization (it takes `TopMeanCoordinatorRunRequest`) and include the
    field there if it enumerates fields explicitly.
  - Browser: add select `batchBacktestSp500TopMeanCapTilt` (Off / Small-base
    ×2 / Large-base ×2) to the coordinator fields row in
    `html-partials/tab-batch-backtest.html` (a `batch-field batch-field--inline`
    next to From/To, tooltip mirroring the standalone one), add the id to
    `batch-backtest-dom.ts` (required-ids const + `createBatchBacktestDom()`),
    and include `capTiltWeight` in the coordinator payload (omit when off).
    The coordinator gets its OWN select — it must NOT read the standalone
    section's `batchBacktestOpenScoreUsdCapTilt`; the two sections are
    independent by design.
- **Dependencies**: Phases 1–2 (implemented): engine option, report echo,
  reader leaf.
- **Risks**: the resume path (`resume?: boolean`) — if a resumed run
  reconstructs its request from persisted state rather than the POST body,
  `capTiltWeight` must survive that round-trip (manifest field above);
  verify during implementation. Import hygiene: the engine may import ONLY
  the reader leaf from `lib/ibkr-data/` — never
  `ibkr-data-vite-plugin.ts`. Also the fatal path must not leave the run
  marked partially complete (mirror how an existing preflight/pair-load
  fatal terminates the run).
- **Deliverables**: threaded option (request → limits → routes → engine →
  both replay passes), manifest provenance, coordinator select.
- **Validation**:
  - `tests/sp500-top-mean-request-limits.spec.ts` — enum acceptance/rejection
    cases.
  - `tests/sp500-top-mean-server-plugin.spec.ts` — 400 on bad enum through
    the route; existing cases stay green.
  - `tests/feature-dom-contracts.spec.ts` — new coordinator id.
  - `npm run typecheck`; then the full replay-engine spec
    (`tests/batch-open-score-usd-replay-engine.spec.ts`) unchanged.
- **Exit criteria**: "Run TOP_MEAN" with Small-base ×2 produces Copy
  OPEN_SCORE reports whose every `config |` line reads
  `capTilt=smallBase2x`, and TOP_MEAN/TOP_RAW lines differ from an Off run
  on the same universe; Off (or absent field) reproduces the pre-Phase-5
  coordinator output exactly; manifest of a weighted run records the
  weighting; missing marketcap dir fails the run loudly with the actionable
  message.

## Assumptions and unknowns

- **Symbols in artifacts match marketcap files**: synthetic/crypto pairs and
  any symbol not downloaded fall back to `w = 1`. For an S&P 500 IBKR 4H
  universe with the marketcap dataset downloaded, coverage should be near
  total; the fallback keeps mixed universes working.
- **Caps at entry date** come from the on-disk daily series (as-of date —
  no survivorship bias). Re-downloading marketcap data between runs changes
  later runs' inputs; reports echo the weighting but not the cap-file
  snapshot — accepted for a local research tool.
- **All score-derived arms shift under a weighting** (TOP_RAW, TOP_ADJUSTED,
  TOP_MEAN, MAX_*, acceleration, HHI splits, freshness). This is the point
  of Option A (mutate the vote, re-run, compare TOP_MEAN lines) — the plan
  intentionally does NOT add parallel-counter arms or guard old arms.
- **Coordinator path**: supported as of Phase 5 — "Run TOP_MEAN" applies the
  selected weighting to BOTH its full-range and per-calendar-year replay
  passes. The standalone OPEN_SCORE USD rerun and the coordinator have
  INDEPENDENT selects (matching the existing pattern where each section owns
  its horizons/From/To); neither changes the other's stored results.
- **Tie behavior**: equal caps (`capBase === capQuote`) match neither tilt
  condition → `w = 1`.
