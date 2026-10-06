# Confirmed defects remediation plan

Status: Accepted scope; planning only; no fixes implemented.
Date: 2026-10-06.

Scope: implement the six findings accepted after the codebase investigation.
This temporary plan is in `docs/` at the user's explicit request, overriding
the index's normal exclusion of active implementation plans. After delivery,
fold behavior into the owning guides and remove this plan.

## Baseline and boundaries

The investigation passed application/test typechecks and 334 existing tests
across 15 specs using in-memory bundles. Separate reproductions demonstrated
the defects; passing existing tests does not cover these regressions. Rust
runtime behavior, deployed D1 schemas, and production provider behavior were
not verified.

Keep the existing Vite/browser services, TypeScript/Rust kernels, D1 binding,
Worker endpoints, and Telegram integration. No new service, dependency,
optimization framework, UI control, or strategy-library rewrite is needed.
Preserve settings compatibility, time normalization, execution models,
Finder/Batch ownership and wire shapes, and generated manifests.

Read [the agent guide](../AGENTS.md), [testing](testing.md),
[engine contracts](backtest-engines-typescript-rust.md),
[path exits](path-dependent-exits.md), [Finder](finder.md),
[server Finder](finder-server-side.md), [price data](price-data.md), and
[Worker documentation](../workers/README.md) for the affected phase.

| Phase | Change | Principal owners | Dependency |
| --- | --- | --- | --- |
| 1 | Independent percentage drawdown maximum | TS/Rust kernels, statistics, Monte Carlo, pair-neutral metrics | First priority |
| 2 | Walk Forward exit-override parity | `lib/strategies/walk-forward.ts`, `lib/walk-forward-service.ts` | Phase 1 for final metric assertions |
| 3 | Complete Worker schema | `workers/migrations/`, `workers/entry-signal-worker.ts` | Deployed-schema inventory before rollout |
| 4 | Backtest publication ownership | State actions, backtest service, endpoint facade | Independent |
| 5 | Executed-close exit notifications | Signal evaluator, Worker, alert client types | Phase 3 before deployment |
| 6 | Mode-aware live candle rendering | Data manager, chart manager, HA utility | Independent |
| 7 | Integration and release checks | Existing guides, tests, CI commands | Phases 1-6 |

## Phase 1 - Correct percentage drawdown

**Objective:** The equity path `10000 -> 5000 -> 100000 -> 90000` must report
`maxDrawdown = 10000` and `maxDrawdownPercent = 50`, rather than 10 percent.

**Tasks:**

- In [position-stats.ts](../lib/strategies/backtest/position-stats.ts), update
  `calculateMaxDrawdown` to maximize dollars and percentage independently.
- Apply the same arithmetic in [backtest-engine.ts](../lib/strategies/backtest/backtest-engine.ts):
  single-position fast-path tracking and final liquidation, the shared
  fallback loop, and `combineCompactResults` for combined books.
- Update `simulateChartTradePath` in
  [monte-carlo-engine.ts](../lib/strategies/monte-carlo/monte-carlo-engine.ts),
  the exported drawdown helper in
  [path-dependency-analyzer.ts](../lib/strategies/monte-carlo/path-dependency-analyzer.ts),
  and [finder-pair-neutral.ts](../lib/finder/finder-pair-neutral.ts).
  Preserve the analyzer's dollar-drawdown start/end semantics.
- Update Rust's streaming drawdown closure and `calculate_max_drawdown` in
  [engine.rs](../rust-engine/src/backtest/engine.rs). Preserve the existing
  nonpositive-peak guard and intentional `skipDrawdown` behavior.

**Contract / risk:** Metric field names and wire shape stay unchanged;
ranking and genetic fitness will legitimately change. Existing scalar-only
Finder/Batch snapshots and archives cannot be repaired without original
execution data: retain them as historical output and require reruns for
corrected metrics. Do not silently rewrite persisted research records.
Deploy a rebuilt Rust service with the TS correction; use the existing
TypeScript selection while an old Rust binary remains unverified.

**Deliverables / validation:** Regression fixtures in
`backtesting-engine.spec.ts`, `backtesting-engine-compact-parity.spec.ts`,
`monte-carlo-sizing.spec.ts`, `finder-pair-neutral.spec.ts`, and Rust tests;
add a focused helper spec where necessary. Assert independent expected
values, equal dollar losses at different peaks, zero/negative equity,
long/short and combined books, final-close fees, and skip modes. Add a Finder
ranking assertion showing the corrected percentage affects ordering.

**Exit:** All percentage-producing paths retain the worst relative loss;
TS/Rust supported configurations agree. Document metric semantics and the
historical-result limitation in the engine/Finder guides.

## Phase 2 - Honor Walk Forward exit overrides

**Objective:** The same OOS trade exits at 110 in both Walk Forward and the
normal executor, rather than remaining open until a 200 window-end price.

**Tasks:**

- Retain `createWindowBacktestContext`, prepared primary-strategy data,
  window filtering, compact IS execution, and existing OOS accounting in
  [walk-forward.ts](../lib/strategies/walk-forward.ts).
- Make `prepareWindowBacktest` await the existing exported
  `resolveExitStrategyOverrideSignals` from
  [backtest-executor.ts](../lib/backtest-executor.ts). Use
  [mergeExitStrategySignals](../lib/exit-strategy-merge.ts) before
  `filterSignalsForWindow`; this preserves exit-only tagging and a single
  execution shift in the simulation kernel.
- Await the affected internal runners from optimization, fixed-param, and
  quick paths. Public analyses already return promises. Preload and validate
  an active exit strategy before candidate scoring so a load failure cannot
  become an empty override or disappear inside the optimizer's catch/continue.
- Pass the captured chart interval explicitly through the existing WFA
  configuration/run context to the resolver, including quick mode. Current
  WFA APIs have no interval parameter; add optional interval context without
  changing existing callers with inactive overrides, and fail clearly if an
  active override lacks the required context. Do not read global state in the
  pure engine or guess an interval for irregular data.
- Use the same preparation for `estimateTradeFrequency` and its autosuggest
  caller in [walk-forward-service.ts](../lib/walk-forward-service.ts).

**Performance / risks:** Generate exit signals on buffered history ending at
the window boundary. Cache a fixed exit configuration only within its exact
window and release it with that window; avoid resolving an unchanged exit
series for every entry parameter candidate. Preserve confirmation, polarity,
warm-up, cancellation/yield budgets, and `next_open` boundary semantics.
Do not replace compact optimization with full executor results or retain
trades for every candidate. Regression results with overrides disabled must
remain unchanged.

**Deliverables / validation:** Extend `walk-forward-engine.spec.ts` and
`walk-forward-thresholds.spec.ts`. Compare actual trades/metrics with the
shared executor on identical OOS windows and capital. Cover fixed, optimized,
quick and autosuggest paths; long/short, next-open execution, warm-up signals,
boundary exits, zero-signal exits, missing strategies, and cancellation.
Use a deterministic fixture with the observed 1000-versus-10000 profit gap.

**Exit:** All WFA paths use the selected override, preserve window causality,
and surface preparation failures. Update the engine guide with WFA parity.

## Phase 3 - Ship the required Worker schema

**Objective:** A database initialized solely from shipped migrations supports
subscription upsert, cached states, and committee alert rules.

**Tasks / deliverables:** Add the next forward migration, proposed
`workers/migrations/0006_alert_state_schema.sql`; leave migrations 0001-0005
unchanged. Match the existing SQL and `CommitteeAlertRuleRow` in
[entry-signal-worker.ts](../workers/entry-signal-worker.ts):

- Add nullable `committee_tag TEXT` and `latest_state_json TEXT` to
  `signal_subscriptions`. Existing subscriptions need no synthetic backfill;
  unevaluated state keeps the existing `no_cached_state` behavior.
- Create `committee_alert_rules` with `committee_tag TEXT PRIMARY KEY`,
  `enabled`, `long_threshold`, `short_threshold`,
  `last_fired_score_sign`, nullable `last_fired_at`, and `updated_at`.
  Defaults must match current handlers: disabled, thresholds +1/-1,
  sign 0, null fire time, and a current timestamp.
- Guard the whole optional `runCommitteeAlertPass`, including its initial
  reads, with structured error logging, so a query failure does not reject an
  otherwise completed subscription cron pass. Do not hide upsert/read failures.
- Update `workers/README.md` with the complete migration list and remove the
  resolved known-gap note. Use the configured `SIGNALS_DB` binding/database,
  rather than assuming the README's sample database name matches a deployment.

**Blocker / deployment:** Existing installations may have manually added
columns or the table. Inventory their schema and migration history first;
SQLite cannot make ordinary `ADD COLUMN` blindly idempotent. Verify definitions
and document an operator reconciliation path for such databases before
applying migration 0006. Do not drop data or mark a migration applied without
checking the complete schema. Apply additive schema changes before Worker
deployment; no new binding or cron policy is required.

**Validation:** Add a proposed `worker-schema-migrations.spec.ts` using
`node:sqlite` with an in-memory database and a small D1 statement adapter.
Apply actual SQL migrations and exercise Worker upsert, state writes/batch
reads, rule upsert/list, and scheduled committee evaluation. Test fresh and
existing-data upgrades, plus query failure isolation. Then verify the local
D1 migration path against the deployment configuration before remote rollout.

**Exit / rollback:** Migration-created schemas execute all required SQL and
preserve existing rows. A Worker code rollback leaves the additive schema
in place; production database rollback requires a verified backup, not
destructive reverse migrations.

## Phase 4 - Prevent obsolete backtest publication

**Objective:** Switching BTC/1m to ETH/5m or clearing results during execution
cannot republish BTC results or label BTC candles as ETH in endpoint copying.

**Tasks:**

- Capture one request before the first UI delay in
  [BacktestService.runCurrentBacktest](../lib/backtest-service.ts): market
  type, symbol, interval, strategy, params, settings, capital, block range,
  evaluation time, and a stable candle snapshot. Live data mutates arrays;
  preserve Time shapes when copying mutable candle/time values.
- Keep `interactiveRunSequence` for competing runs. Add a small publication
  revision owned by [state-actions.ts](../lib/state-actions.ts); advance it
  for context changes, explicit result clears, replacement datasets, and
  competing result commits. Check it and the captured context before publishing
  or changing completion/error UI. Include change-away-and-back cases.
  Avoid importing the backtest service into state actions; use the existing
  state/write boundary rather than a new event framework.
- Pass captured identity explicitly into `createEndpointCopySnapshot` in
  [backtest-endpoint-facade.ts](../lib/backtest-endpoint-facade.ts).
  Guard `runLatestUiBacktestEndpointPreview` after its await with the same
  ownership rules so it cannot overwrite a clear or a newer result.
- Keep presenter finish/cleanup behavior for obsolete runs. Forward an abort
  signal through the existing executor context where useful, but publication
  checks remain authoritative even if cancellation arrives too late.

**Risk:** Snapshot work occurs once per interactive request, not in Finder
candidate loops. Raw tick mutations must not invalidate every run; capture
a stable dataset while explicit load/import replacements invalidate ownership.
The publication revision is transient and requires no localStorage migration.

**Deliverables / validation:** Add a focused proposed
`backtest-service-lifecycle.browser.spec.ts`, using deferred promises and the
existing `waitFor`/`withTimeout` helpers. Exercise every UI-delay boundary,
symbol/interval/market/strategy/block changes, clears, replacement data,
competing result sources, late errors, and endpoint previews. Extend
`backtest-endpoint-copy.spec.ts` to assert snapshot/data identity.

**Exit:** Obsolete completions cannot change results, snapshots, replay
availability, or newer progress UI. Update the endpoint guide's snapshot rules.

## Phase 5 - Notify on executed position closes

**Objective:** A previously notified long/short position produces an exit
message when it closes, without requiring an opposite executed entry.

**Tasks / contract:** Keep `latestEntry` as an executed-entry result in
[signal-entry-evaluator.ts](../lib/signal-entry-evaluator.ts). Derive a bounded
exit summary from the same simulation: entry identity/direction, actual exit
time and fill price, reason, and whether the position fully closed. Carry it
through `ProcessSignalResult` to `runSubscription`; do not rerun the strategy
or expose a full trade ledger. Match the stored actionable entry using
`entryTimeSec` and direction; legacy payloads lacking entry time must reuse
the existing source-signal/execution matching rather than equating a shifted
signal timestamp with entry time.

Replace the opposite-entry predicate with matched executed closure detection.
Exclude `end_of_data`, which the evaluator intentionally treats as an open
trade. A partial exit alone must not send a full-position close message.
Preserve current both-direction flip behavior (new-entry notification) and
existing entry deduplication. This fixes ordinary signal closes and supports
real risk/time closes through the same execution-derived summary.

Use `buildExitTelegramMessage` with actual exit values. Keep a bounded exit
identity in the existing `exit_alert:` status suffix, persist it only after
successful delivery, and log delivery failures without fabricating success.
Preserve best-effort delivery; the current status-based dedupe does not
guarantee exactly-once notification under concurrent cron/manual runs.
Do not introduce a queue or new exit-history table in this scope.

**Dependencies / compatibility:** Deploy after Phase 3. Update additive
optional evaluator/client context types in [alert-service.ts](../lib/alert-service.ts)
and cached-state consumers only where exposed; legacy cached JSON and older
responses must remain readable. No new endpoint or settings field is needed.

**Deliverables / validation:** Extend `alert-entry-evaluator.spec.ts` and
`entry-signal-worker.spec.ts`: notified long/short signal closes, stop/target/
time exits, next-open/slippage, stale entries, open/end-of-data positions,
partial closes, duplicate evaluations, legacy entry identity, missing secrets,
and failed Telegram sends. Assert HTTP/run status and actual Telegram calls.

**Exit:** Single-direction closes produce one notification across repeated
successful sequential evaluations; entry notifications retain their behavior.
Document supported close semantics and best-effort limitations in Worker docs.

## Phase 6 - Render live candles in the selected chart mode

**Objective:** Market ticks display the same Heikin Ashi values as a full
redraw while raw OHLCV remains available to strategies and persistence.

**Tasks:** Replace the direct series update in
[DataManager.applyRealtimeCandle](../lib/data-manager.ts) with a narrow
chart-owned live-update method in [chart-manager.ts](../lib/chart-manager.ts).
Reuse [toHeikinAshi](../lib/heikin-ashi-utils.ts) formulas. Keep ordinary
candlesticks on their existing incremental path; retain raw lookup/persistence
updates and avoid emitting a new data commit for every tick.

For HA replacements/appends, retain only the prior transformed candles and
source identity needed to calculate the tail in constant time. Rebuild through
`updateChartData` on initial load, mode/context changes, historical replacement,
or rolling-window eviction, because reseeding the first HA bar changes later
values. Reset the bounded tail state on those transitions. Preserve visible
range and paper-stream ownership; do not route shared server loaders through
browser chart modules.

**Performance / validation:** Avoid a full 50000-bar transform for every tick.
Extend `data-manager-stream.browser.spec.ts` and add a focused chart/HA spec
if needed. Compare replacements, appends, mode toggles, initial empty data,
gap-fill commits, and evictions against full transformation; assert raw data
is unchanged and repeated same-bar ticks do not call full `setData`.

**Exit:** Live/displayed HA equals a full redraw, normal candle behavior stays
incremental, and chart-owned retained state remains bounded. Document visual
versus raw data behavior in the price-data guide.

## Phase 7 - Validate and deliver

**Tasks / validation:** After each implementation phase, run
`npm run validate:changes` and its focused checks; add semantic-impact tests
beyond the advisory mapping. Run test selections sequentially to preserve
runner logs. Finish with application/test typechecks and `npm run ci`, plus
`npm run test:e2e` for market switching, endpoint preview, and chart modes.
Under `rust-engine/`, run `cargo fmt --check`, `cargo test`, and
`cargo clippy --all-targets -- -D warnings`, then live supported-configuration
parity with Rust available and TypeScript fallback with Rust unavailable.
Retain the existing CI policy and disclose any unavailable check.

Use mocked provider/Telegram I/O for deterministic tests; real deployment
validation requires the configured D1 instance and local/remote migration
history. Worker API bearer protection, Vite local authorization, secrets,
and subscription enabled flags remain unchanged. No live messages or remote
migrations are part of creating this plan.

**Deliverables / exit:** Each original reproduction passes as a regression,
focused and required broad checks pass, and owning guides describe final
behavior. Keep phases independently reviewable and stop rollout of a phase
whose exit criteria fail; do not compensate by changing unrelated behavior.

**Rollback:** Revert affected code phases independently, preserving additive
D1 schema and stored settings. Coordinate TS/Rust versions and rerun research
after metric changes; reverting code does not retroactively repair archives.
For Worker rollback, keep new optional JSON fields backward-compatible. Remove
this temporary plan after the shipped contracts and deployment notes have
been folded into the durable guides.
