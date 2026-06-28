# Signal Committee Plan

## Goal

Add a new strategy-panel tab, **Signal Committee**, that aggregates the live
direction vote of multiple strategy configurations (each a saved pair + timeframe
+ strategy + params + settings) into one score, plus per-row freshness and
unrealized-gain diagnostics.

The committee must answer:

- "What is the net directional vote across my members right now?"
- "How stale is each member's open trade, and how much is it up or down?"

It must stay fresh even when the browser was closed overnight.

## Hard v1 Limitation: Worker-Supported Members Only

A committee member is a Cloudflare Worker `signal_subscriptions` row. The
worker can only evaluate strategies that are worker-supported, which excludes:

- **cross-symbol / synthetic-pair strategies** (`ZEC+APT`, `BNBPAXG`, etc.)
  - `crossSymbolSecondary` is `workerSupport: "unsupported"`
    (`lib/backtest-settings-dom-contract.ts:352`)
  - `isWorkerSupportedStrategyKey` rejects any strategy with a
    `crossSymbolConfig` (`lib/alert-subscription-utils.ts:51`)
- **`polymarket1sConfig` strategies** (same rejection in
  `isWorkerSupportedStrategyKey`)

This is a hard architectural fact of the repo, not a design choice. The
example pair `ZEC+APT` from the brainstorm **cannot** be a committee member
in v1 because the worker cannot evaluate it.

Consequences for v1:

- The Signal Committee tab must refuse to add a member whose current chart
  strategy is cross-symbol or 1s-Polymarket. Surface a clear inline message
  pointing to `isWorkerSupportedStrategyKey` as the source of truth.
- The add flow reuses the existing worker-compatibility check
  (`isWorkerSupportedStrategyKey` + the same provider mismatch path already
  used by the Alerts tab via `lib/alert-worker-compat.ts`).
- Members must be single-symbol, Binance-sourced strategies.

Future support for synthetic-pair members is tracked in
"Out of Scope" — it requires browser-side evaluation (since the worker cannot
do it) and a parallel committee state path. That is a separate, larger plan.

## Design Corrections (vs the original brainstorm)

### 1. Membership = tagged subscriptions, not "all subscriptions"

The Cloudflare Worker evaluates **every enabled subscription** on its 1-minute
cron (`workers/entry-signal-worker.ts` `scheduled()` +
`runScheduledSubscriptions()`). The original "membership = all subscriptions"
framing was wrong-by-omission: it would count unrelated alert subscriptions in
the committee score.

A committee member is a `signal_subscriptions` row that is both:

- enabled (existing `enabled` column gates cron eval), AND
- tagged for committee membership.

Two implementation options, decided once in Phase 1 task 1:

- **Option A — server-side tag column.** Add `committee_tag TEXT NULL` to
  `signal_subscriptions` (additive migration `0007_committee_tag.sql`).
  The committee is `WHERE committee_tag IS NOT NULL`. Upsert writes the tag;
  list filters on it. Preferred: matches the multi-device, "freshness when
  browser closed" goal natively, and keeps the Alerts tab untouched.
- **Option B — UI-only filter.** No schema change. The browser keeps a
  localStorage set of `streamIds` and filters `listSubscriptions()` results.

  Cheaper, but breaks the "open the browser tomorrow, data is fresh" promise
  when localStorage is cleared or another device is used, and it leaks stale
  committee config across browser resets.

Option A is preferred. Option B is the fallback if migration overhead is
undesirable. The choice is explicit in Phase 1 task 1; it is **not** deferred.

Consequences (either option):

- Add = `saveStrategyConfig` + `alertService.upsertSubscription(...)` with
  committee tag/stream-id recorded.
- Remove = `alertService.deleteSubscription(streamId, { hardDelete })` +
  optional local `StrategyConfig` cleanup.
- The Alerts tab continues to show every subscription (committee-tagged or
  not). The Signal Committee tab shows only committee-tagged rows. They must
  not disagree about the underlying row state of a given `streamId`.

### 2. Do not extend Ensemble Lab

Ensemble Lab is bound to the **current chart** symbol/interval and shares a
single candle window across all context configs
(`lib/strategy-ensemble-service.ts`). Unbinding it from the current chart is a
large semantic change that risks its existing contract surface (target votes,
agreement buckets, polymarket runner, recipe builder — all assume one chart).

Signal Committee is cross-(symbol × interval) by design and must be its own
tab. It consumes the worker, not the live chart.

### 3. Do not reinvent existing helpers

- Stream id: reuse `buildAlertStreamId` / `parseAlertConfigNameFromStreamId`
  from `lib/alert-service.ts`.
- Subscription lifecycle: reuse `alertService.upsertSubscription`,
  `alertService.deleteSubscription`, `alertService.listSubscriptions`,
  `alertService.getSubscriptionState`.
- Saved config lifecycle: reuse `settingsManager.saveStrategyConfig`,
  `settingsManager.loadStrategyConfig`.
- Worker eval semantics: reuse `evaluateLatestEntrySignal`
  (`lib/signal-entry-evaluator.ts`). The worker already calls this.
- Cross-timeframe signal mapping (Phase 3 chart overlay): reuse
  `mapSignalsFromHigherTimeframe` from `lib/strategy-timeframe.ts`.

### 4. Per-row "open trade" means position held, not latest signal

Score contribution is `+1 / -1 / 0` based on the **latest executed trade** with
`isOpen === true` from `/api/subscriptions/state` (`latestTrade.isOpen`).
This matches `EvaluatedLatestTradeContext` in `lib/signal-entry-evaluator.ts`
and is what the worker already evaluates and stores. A transient entry signal
that did not produce an open trade does not contribute.

## System Architecture (actual, not invented)

Existing components Signal Committee reuses:

```
[UI: Signal Committee tab]
    |
    |  alertService.listSubscriptions()
    |  alertService.getSubscriptionState(streamId)    (per-row, today)
    |  alertService.getCommitteeState(streamIds)      (NEW batched, Phase 1 task 2)
    v
[Cloudflare Worker: workers/entry-signal-worker.ts]
    |   fetch handler: /api/subscriptions, /api/subscriptions/state,
    |                  /api/subscriptions/states (NEW)
    |   scheduled(): cron every minute, evaluates enabled subs
    v
[D1: signal_subscriptions, entry_signals]
    |   last_processed_closed_candle_time guard avoids duplicate evals
    |   signal_subscriptions.updated_at / last_run_at / last_status
    |   NEW: signal_subscriptions.latest_state_json (written by cron, read by batched endpoint)
    |   NEW: signal_subscriptions.committee_tag (Option A only, filters membership)
    v
[Binance-compatible candle fetch]
    |   2h subscriptions already composed from 1h source candles
```

New components:

```
html-partials/tab-signal-committee.html         (NEW partial)
lib/signal-committee-dom.ts                     (NEW feature-local DOM contract)
lib/signal-committee-service.ts                 (NEW orchestrator: refresh, add, remove, render)
lib/signal-committee-renderer.ts                (NEW pure render of rows + header)
lib/signal-committee-score.ts                   (NEW pure: rows -> score/freshness/gain aggregates)
lib/handlers/signal-committee-handlers.ts       (NEW: wire DOM events)
workers/migrations/0006_committee_state_columns.sql  (NEW: latest_state_json column)
workers/migrations/0007_committee_tag.sql            (NEW, Option A only: committee_tag column + index)
```

No new directories under `lib/`. No new entrypoints. No new providers.

## Module Boundaries

- `signal-committee-service.ts` — owns the in-memory row cache, the
  refresh loop, and add/remove orchestration. Talks only to
  `alertService` and `settingsManager`. Never touches the chart or DOM directly.
- `signal-committee-renderer.ts` — pure functions: `(rows) => HTML`.
  No fetches, no state mutation.
- `signal-committee-score.ts` — pure functions: `(rows) => aggregates`.
  Unit-testable without DOM or network.
- `signal-committee-handlers.ts` — wires DOM events to service methods,
  reusing `getOptionalElement` + `signal-committee-dom.ts`. Matches the
  pattern in `lib/handlers/alert-handlers.ts`.
- `signal-committee-dom.ts` — exports `SIGNAL_COMMITTEE_REQUIRED_IDS` and
  `createSignalCommitteeDom()`. Consumed by `tests/feature-dom-contracts.spec.ts`
  like every other feature-local `*-dom.ts`.

Hard rule: the chart overlay (Phase 3) talks to `chart-manager.ts` only
through the same series-creation surface used by indicators. No new chart API.

### Tab registration coupling (4 files, all required)

Adding a new lazy-loaded strategy-panel tab touches **four coupled files**.
Missing any one silently breaks the tab (button click does nothing, or the
panel never loads). They must be updated together:

1. `html-partials/strategy-panel-shell.html` — add
   `<button class="panel-tab" data-tab="signalcommittee" …>Committee</button>`
   to the secondary `panel-tabs-row`.
2. `lib/strategy-panel-tab-markup.ts` — add
   `signalcommittee: () => import('../html-partials/tab-signal-committee.html?raw')`
   to `LAZY_STRATEGY_PANEL_TAB_LOADERS`. Without this,
   `ensureStrategyPanelTabMarkup("signalcommittee")` is a no-op and the
   panel never fills.
3. `lib/lazy-feature-init.ts` — add
   `signalcommittee: "signal-committee"` to `TAB_TO_FEATURE`. Without this,
   the tab-change listener never activates the feature and the button is dead.
4. `lib/app-bootstrap.ts` `registerLazyFeatures()` — add
   `registerLazyFeature("signal-committee", async () => (await import("./handlers/signal-committee-handlers")).initSignalCommitteeHandlers())`.

The partial itself (`tab-signal-committee.html`) is **not** added to
`layout-manager.ts`'s `EAGER_STRATEGY_PANEL_TAB_PARTIALS` — it must stay
lazy to match every other research tab. The placeholder is injected by
`appendLazyStrategyPanelTabPlaceholders` automatically once (2) is updated.

## Data Flow

### Add Current Configuration

1. User on chart `(symbol, interval, strategyKey, params, settings)` clicks
   **Add Current Configuration**.
2. Service prompts for a name (mirror `saveStrategyConfig`'s naming flow in
   `lib/handlers/settings-handlers.ts:97`).
3. `settingsManager.saveStrategyConfig(name)` — persists local config snapshot.
4. `alertService.upsertSubscription({ streamId: buildAlertStreamId(...), ... })`
   with current chart context. The stream id is the membership record.
5. Refresh loop picks it up on the next tick; row appears in the table.

### Refresh (manual or auto)

1. **Health gate.** `alertService.healthCheck()` on tab open. If it fails or
   returns an unsupported manifest fingerprint, the tab renders an empty
   state pointing to the Alerts tab to configure the worker. The committee
   is useless without a live worker — silent staleness is the failure mode
   this must prevent.
2. `alertService.listSubscriptions()` — one fetch, returns all rows
   (`GET /api/subscriptions`). Client filters to committee-tagged rows.
3. For each tagged row, fetch state. **Phase 1 task 2** adds a batched
   endpoint `POST /api/subscriptions/states` so all members resolve in one
   request. Until that lands, fall back to N parallel `getSubscriptionState`
   calls (bounded by `Promise.all`; cap at 25 members, warn above 10).
4. `signal-committee-score.ts` computes aggregates from states.
5. `signal-committee-renderer.ts` rewrites the table + header.

### Remove

1. User clicks X on a row.
2. `alertService.deleteSubscription(streamId, { hardDelete: true })`.
3. Confirm whether to also delete the local `StrategyConfig` (default: keep).
   This mirrors the Alerts soft-disable/hard-delete distinction already in
   `alertService.deleteSubscription`.

## API / Contracts

### Existing endpoints (no change)

- `GET /api/subscriptions` → list
- `GET /api/subscriptions/state?streamId=...` → single state
- `POST /api/subscriptions/upsert` → create/update
- `POST /api/subscriptions/delete` → soft or hard delete
- `GET /api/stream/signals?streamId=...&limit=...` → signal history (Phase 3 input)

### New endpoint (Phase 1 task 2)

`POST /api/subscriptions/states`

Request:
```json
{ "streamIds": ["btcusdt:1h:strat:cfg:name1", "..."] }
```

Response (one element per input id, same shape as `SubscriptionStateResult`,
plus `latestClose`):
```json
{
  "ok": true,
  "states": [
    {
      "streamId": "...",
      "symbol": "BTCUSDT",
      "interval": "1h",
      "strategyKey": "...",
      "evaluatedAt": "2026-06-20T...Z",
      "closedCandleTimeSec": 1750000000,
      "latestClose": 63250.4,
      "latestTrade": {
        "entryTimeSec": 1750000000,
        "entryPrice": 63000.0,
        "isOpen": true,
        "exitReason": null,
        "takeProfitPrice": null,
        "stopLossPrice": null
      },
      "latestEntry": { "direction": "long", "signalAgeBars": 3, "isFresh": true, ... }
    }
  ]
}
```

### Why the batched endpoint cannot re-evaluate per stream

The single-state handler re-runs `evaluateLatestEntrySignal`, which calls
`runBacktest` over the fetched candle window. That is the right semantics for
on-demand single-stream state, but doing it for N streams in one request:

- exceeds Cloudflare Worker CPU budget (free-tier 50ms CPU, paid-tier 30s
  wall but billed, with N backtest runs growing linearly)
- duplicates work the cron already did (the subscription was evaluated on
  the last tick)

So the batched endpoint **must not** re-evaluate. It reads precomputed state.

### Precomputed state: `latest_state_json` column

The architectural reconciliation:

- The cron already computes the full `EntrySignalEvaluationResult`
  (`latestTrade`, `latestEntry`, `closedCandleTimeSec`) for every enabled
  subscription on every due tick. Today it discards the result after deciding
  whether to insert an `entry_signals` row.
- Phase 1 task 2 persists that result. Add a column
  `latest_state_json TEXT NULL` to `signal_subscriptions`
  (migration `0006_committee_state_columns.sql`). The cron writes it after
  every successful evaluation. The batched endpoint reads it.

This resolves both W5 (CPU budget — the batched read is one SQL query, no
re-eval) and W6 (`latestClose` — the cron already has the candle in memory
when it writes `latest_state_json`, so it stamps `latestClose` in the same
JSON, no extra fetch).

Write semantics: the cron writes `latest_state_json` on every due tick even
when no new signal fired, so `latestClose` stays current between signals.
The `last_processed_closed_candle_time` guard still prevents re-eval; the
state write happens inside the existing eval path, not as a new pass.

Single-state handler (`/api/subscriptions/state`) keeps re-evaluating for
back-compat and on-demand freshness (Alerts tab uses it). Both paths return
the same shape; the batched path is just a cached read.

### New field: `latestClose`

The close price of the candle at `closedCandleTimeSec`, stamped into
`latest_state_json` by the cron at eval time. Gain-since-entry is computed
client-side:
`gainPct = ((latestClose - entryPrice) / entryPrice) * dirSign`.
If `latestClose` is absent (old worker, or pre-first-eval row), the gain
column renders "—" and is excluded from `avgGainPct`.

## State Management

No new app-wide state. Per-tab runtime state lives inside
`signal-committee-service.ts` as private fields, mirroring how
`lib/alert-subscription-renderer.ts` keeps a `Map<string, AlertSubscription>`
in `alert-handlers.ts`.

Persistence:

- Member identity lives in D1 (`signal_subscriptions`). Already multi-device.
- Optional UI prefs (sort order, auto-refresh interval, column visibility)
  route through `lib/persisted-json.ts` under a `signal_committee_prefs` key
  with a schema version envelope. Not member data.

## Infrastructure

- Cloudflare Worker: must be deployed with cron `* * * * *`. The tab's
  health-check gate makes a missing/stale deployment visible instead of
  silent.
- D1: two additive migrations.
  - `0006_committee_state_columns.sql`:
    ```sql
    ALTER TABLE signal_subscriptions ADD COLUMN latest_state_json TEXT NULL;
    ```
    Written by the cron after every due evaluation. Read by the batched
    `/api/subscriptions/states` endpoint. Decouples batched reads from
    per-stream re-evaluation (resolves the Worker CPU budget issue).
  - `0007_committee_tag.sql` (Option A only):
    ```sql
    ALTER TABLE signal_subscriptions ADD COLUMN committee_tag TEXT NULL;
    CREATE INDEX IF NOT EXISTS idx_signal_subscriptions_committee_tag
        ON signal_subscriptions(committee_tag) WHERE committee_tag IS NOT NULL;
    ```
    Required only if Phase 1 task 1 selects Option A (server-side tag).
- Both migrations are additive (`ADD COLUMN` / `CREATE INDEX`). Rollback is
  "ignore the column". Never destructive.
- Confirm at implementation time that no in-flight branch has taken
  `0006`/`0007`. The highest existing migration today is
  `0005_actionable_entry_signal_index.sql`.
- No new env vars. Worker already supports `WORKER_API_TOKEN`, Telegram,
  Binance bases.
- No new secrets.

## Observability / Logging

- Worker side: `console.info(JSON.stringify({ event: "scheduled_run_summary", ... }))`
  already exists. Add a per-stream log line for batched state fetches only if
  debugging is requested. Do not add chatty logging by default.
- Browser side: reuse `debugLogger` for refresh-loop errors, matching
  `lib/handlers/alert-handlers.ts` style.
- Per-row last-status: surface `signal_subscriptions.last_status` in the row
  table so a stuck/failing subscription is visible (already stored).

## Security Considerations

- `POST /api/subscriptions/states` reuses the existing `isAuthRequired` /
  `isAuthorizedRequest` gate. No new auth surface.
- No secrets in browser. `alertService` already reads token via
  `readAlertWorkerToken()`.
- Batched state response must not leak across tokens (single shared D1 today).
  Same trust boundary as the existing list endpoint.

## Performance Considerations

- Batched state reads from `latest_state_json` (precomputed by cron), not by
  re-evaluating per stream. One SQL `SELECT ... WHERE stream_id IN (...)`
  per batched request. No backtest runs on the read path.
- Cron-side cost grows by one JSON serialize + one `UPDATE` per due
  subscription per tick. Negligible vs. the existing per-tick backtest.
- Phase 1 fallback (N parallel `getSubscriptionState` calls) is only used
  when the batched endpoint is absent (worker not yet redeployed). Hard cap
  at 25 members in the UI; warn above 10.
- Auto-refresh default 30s; never lower than 10s (cron only runs per minute,
  so sub-minute polls can only ever return the same `latest_state_json`).
- Phase 3 chart overlay: forward-fill member votes onto the visible timeframe
  in one pass; do not recompute per visible bar.

## Rollback Strategy

- **Phase 1 UI:** Remove the partial injection and the lazy-init registration
  (4 files listed under Tab registration coupling). No D1 impact.
- **Batched endpoint misbehaves:** UI catches 404/non-JSON once, sets a
  session runtime flag, falls back to N parallel `getSubscriptionState`
  calls for the rest of the session. No data loss. Flag persists for the
  session only.
- **`latest_state_json` write fails on cron:** The cron's existing eval path
  must not regress. Wrap the state-write in try/catch; a failed write logs
  but does not block signal insertion or `last_status` update.
- **`latestClose` absent:** UI treats it as optional. Missing → gain column
  renders "—", row excluded from `avgGainPct`. Old worker + new UI keeps
  working.
- **D1 migrations 0006/0007:** Additive only (`ADD COLUMN` / `CREATE INDEX`).
  Rollback = ignore the column. Never destructive.

## Edge Cases

- Worker URL not configured: show empty state pointing to the Alerts tab,
  do not throw on init (mirror `requireUrl` behavior).
- Worker reachable but D1 empty / no committee-tagged rows: show
  "Add a configuration to start".
- Worker deployed but cron not configured (no recent `last_run_at`):
  health-check gate warns "Worker reachable but subscriptions not running.
  Check cron triggers." so the user does not mistake a static list for a
  live committee.
- Member strategy no longer in manifest (`worker_strategy_not_supported:<key>`
  in `last_status`): render row in error state, exclude from score, surface
  a hint to redeploy the worker or remove the member.
- `latest_state_json` null (subscription created but never evaluated):
  row renders as "pending first eval", excluded from score.
- `latestTrade` null (evaluated, no trade has ever fired): row is FLAT,
  score 0, freshness "—", gain "—".
- `latestTrade.isOpen === false`: row is FLAT (last trade closed), still
  shows last direction and exit reason as muted diagnostics, score 0.
- **Cross-symbol / synthetic-pair strategy on current chart:** Add button
  is disabled with tooltip "Worker does not support cross-symbol
  strategies. Committee members must be single-symbol." This is enforced
  via `isWorkerSupportedStrategyKey(state.currentStrategyKey)`.
- **Polymarket 1s strategy on current chart:** same disabled-button
  treatment, same `isWorkerSupportedStrategyKey` check.
- Cross-timeframe alignment on chart (Phase 3): a 1h member's vote covers
  60 1m bars. Forward-fill using the member's `entry_signals` history, not
  a re-evaluation.
- Two members with identical stream id: cannot happen (D1 UNIQUE on
  `stream_id`). Adding a duplicate is a no-op upsert; the committee tag is
  idempotent under re-add.

## Failure Handling

- `listSubscriptions` fails: keep last rendered rows, show a non-blocking
  error toast via `uiManager.showToast`, retry on next auto-refresh tick.
- A single per-row state fetch fails (fallback path): render that row as
  "stale" with the last known status; do not block the rest of the table.
- Batched endpoint 404 (worker not yet deployed): catch once, set a session
  runtime flag, fall back to N parallel calls for the rest of the session.
- `latest_state_json` for one stream is corrupt/unparseable: skip that row's
  state, render as "state error", exclude from score; never throw.
- Auto-refresh pauses when the tab is hidden (reuse
  `document.visibilitychange`). Resume on focus.

---

# Phased Rollout

## Phase 1 — Core tab, read-only + add/remove

### Objective

A working Signal Committee tab that lists **committee-tagged** worker
subscriptions (not all subscriptions), scores them, and supports add/remove
from the current chart — restricted to worker-supported strategies.

### Scope

- New partial, DOM contract, service, renderer, score module, handlers.
- 4-file tab registration (shell button + tab-markup loader +
  `TAB_TO_FEATURE` + `registerLazyFeatures`).
- Membership tag selection: Option A (`committee_tag` column) or Option B
  (localStorage filter), decided in task 1.
- Worker: batched-state endpoint + `latestClose` + cron-side
  `latest_state_json` write-back + new migration(s).
- Add button gated by `isWorkerSupportedStrategyKey`; cross-symbol /
  1s-Polymarket strategies blocked with an inline message.
- Health-check gate on tab open.
- No chart overlay. No aggregate notifications.

### Technical Tasks

1. **Tab scaffolding + 4-file registration.**
   - Create `html-partials/tab-signal-committee.html` (empty-state, header
     with score + aggregates, table skeleton, `Add Current Configuration` /
     `Refresh` / auto-refresh toggle).
   - Add `<button class="panel-tab" data-tab="signalcommittee">Committee</button>`
     to `html-partials/strategy-panel-shell.html` secondary row.
   - Add `signalcommittee: () => import('../html-partials/tab-signal-committee.html?raw')`
     to `LAZY_STRATEGY_PANEL_TAB_LOADERS` in
     `lib/strategy-panel-tab-markup.ts`.
   - Add `signalcommittee: "signal-committee"` to `TAB_TO_FEATURE` in
     `lib/lazy-feature-init.ts`.
   - Add `registerLazyFeature("signal-committee", ...)` to
     `registerLazyFeatures()` in `lib/app-bootstrap.ts`.
   - **Do NOT** add the partial to `EAGER_STRATEGY_PANEL_TAB_PARTIALS`.
   - **Decide Option A vs B here.** Default: Option A (server-side tag),
     which requires migration `0007_committee_tag.sql`.

2. **Worker: precomputed state + batched read.**
   - Migration `0006_committee_state_columns.sql`:
     `ALTER TABLE signal_subscriptions ADD COLUMN latest_state_json TEXT NULL`.
   - In the cron eval path (inside `runScheduledSubscriptions` / the per-sub
     handler), after a successful `evaluateLatestEntrySignal`, serialize
     `{ latestTrade, latestEntry, closedCandleTimeSec, latestClose }` to
     `latest_state_json` via one `UPDATE`. `latestClose` = close of the
     candle at `closedCandleTimeSec` (already in memory). Wrap in try/catch
     so a write failure never blocks the existing signal-insert path.
   - Add `POST /api/subscriptions/states` handler: body `{ streamIds }`;
     one `SELECT latest_state_json, last_status, updated_at FROM
     signal_subscriptions WHERE stream_id IN (?)` (bound IN). Return parsed
     JSON per stream. Reuses existing auth gate.
   - Migration `0007_committee_tag.sql` (Option A only): adds
     `committee_tag` column + partial index. Upsert in
     `handleSubscriptionUpsert` accepts `committeeTag`; list endpoint
     returns it.

3. **Browser API surface.** Extend `lib/alert-service.ts`:
   - `getCommitteeState(streamIds): Promise<CommitteeStateResult>` calling
     the new endpoint, with one-shot fallback to N parallel
     `getSubscriptionState` calls on 404 / fetch error / non-JSON.
   - Extend `AlertSubscriptionState` with optional `latestClose?: number`.
   - Extend `AlertSubscriptionUpsert` with optional `committeeTag?: string`
     (Option A) — no-op on old worker.

4. **Score module.** `lib/signal-committee-score.ts` pure functions:
   - `voteForRow(row): -1 | 0 | 1`  (open long +1, open short -1, else 0)
   - `aggregateScore(rows): { score, longCount, shortCount, flatCount,
     avgAgeSec, avgGainPct }`  (avgAge and avgGain only over open-trade rows;
     rows with missing `latestClose` excluded from `avgGainPct`).

5. **Renderer.** `lib/signal-committee-renderer.ts` pure functions: header
   HTML, table body HTML, empty/error/health-fail states. Reuses existing
   CSS classes (`analysis-table`, `portfolio-lab__*`, `btn`, `btn-compact`).

6. **Service + handlers.**
   - `lib/signal-committee-service.ts`: refresh loop, row cache, add/remove
     orchestration, health gate, visibility-aware polling.
   - `lib/handlers/signal-committee-handlers.ts`: wires events; on tab open,
     `healthCheck()` first, then list + batched state.
   - Reuse `collectCurrentAlertStrategyParams` and
     `collectCurrentAlertSubscriptionBacktestSettings` from
     `lib/current-alert-subscription.ts` so worker input matches the Alerts
     tab exactly. Add button disabled when
     `!isWorkerSupportedStrategyKey(state.currentStrategyKey)`.

7. **DOM contract + smoke test.** `lib/signal-committee-dom.ts` exports
   `SIGNAL_COMMITTEE_REQUIRED_IDS`. Add import line to
   `tests/feature-dom-contracts.spec.ts`.

8. **Worker contract test.** Extend `tests/entry-signal-worker.spec.ts`:
   - `POST /api/subscriptions/states` honors the auth gate.
   - `latestClose` present in single-state response (mocked D1 + candles).

### Dependencies

- All existing alert-service + settings-manager functions are already
  exported and used by the Alerts tab. No upstream changes needed.
- Worker must be redeployed (new code + migrations) before batched state and
  `latestClose` work. UI degrades gracefully until then.

### Risks / Blockers

- **Cron write-back regression.** Adding the `latest_state_json` write to the
  hot cron path is the highest-risk change. Mitigation: write happens **after**
  the existing signal-insert / status-update; try/catch isolates it; the
  Phase 1 worker test covers the happy path and a write-failure path.
- **Tab real estate.** The secondary panel-tabs row is already wide.
  Mitigation: short label ("Committee"); reuse existing responsive overflow.
- **`committee_tag` migration ordering.** If Option A is chosen, both 0006
  and 0007 must be applied in order before the new upsert code runs.
  Mitigation: ship both migrations together.

### Deliverables

- New tab visible and operational in the running app.
- Worker redeployed with `POST /api/subscriptions/states`, `latestClose`,
  cron-side `latest_state_json` write-back, and `committee_tag` (Option A).
- Migrations `0006_committee_state_columns.sql` and (Option A)
  `0007_committee_tag.sql`.
- Updated `docs/signal-committee-plan.md` noting any deviations from Option A.

### Validation / Testing Criteria

- `npm run typecheck`
- `npm run test` (must include new `tests/signal-committee-score.spec.ts`
  covering: open long/short/flat vote, avg age over open-only rows, avg gain
  sign by direction, missing `latestClose` excluded from `avgGainPct`).
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\entry-signal-worker.spec.ts`
  extended with the two new cases above.
- Manual: with worker deployed and cron set, add a 1m + a 1h single-symbol
  member, confirm both show after the next cron tick, confirm score updates
  without page reload, confirm removing a member removes its row and vote.
- Manual: confirm a cross-symbol strategy on the current chart disables the
  Add button with the right message.
- Manual: confirm an unconfigured worker shows the health-fail empty state
  instead of a blank table.

### Exit Criteria

- Tab loads on a fresh `npm run dev` with no worker configured (health-fail
  empty state, no console errors).
- Add/remove round-trip works end-to-end against a deployed worker.
- Score, avg age, avg gain match a hand-computed value on a 3-member fixture.
- Cross-symbol / 1s-Polymarket strategies cannot be added.
- Unrelated (non-tagged) alert subscriptions do not appear in the committee.
- All validation commands above pass.

---

## Phase 2 — Manual / on-tab refresh polish

### Objective

Make the tab feel live without making it noisy.

### Scope

- Visibility-gated auto-refresh (pause when tab hidden, resume on focus).
- Configurable refresh interval (default 30s, min 10s) persisted via
  `lib/persisted-json.ts`.
- "Last refreshed" timestamp + per-row `last_status` chip.
- Soft-error recovery (transient fetch failures don't blank the table).

### Technical Tasks

1. Add visibility listener + interval selector in `signal-committee-handlers.ts`.
2. Add `signal_committee_prefs` read/write via `lib/persisted-json.ts`.
3. Surface `last_status` and `evaluatedAt` in the renderer.

### Dependencies

- Phase 1 complete.

### Risks / Blockers

- None material. Standard UI work.

### Deliverables

- Polished tab UX, persisted prefs.

### Validation / Testing Criteria

- `npm run typecheck`
- `npm run test`
- Manual: hide tab, confirm poll pauses; refocus, confirm resume.

### Exit Criteria

- Prefs persist across reloads. Hidden tab does not poll. Stale rows show
  their last status clearly.

---

## Phase 3 — Chart overlay (executed scope, 2026-06-20)

### Architectural finding — and resolution

The original Phase 3 spec called for a per-bar historical committee score
with cross-timeframe forward-fill. A first-pass review concluded this was
not derivable because `GET /api/stream/signals` returns entries only and no
`exit_signals` table exists. That conclusion was **incomplete**: the
underlying evaluator (`evaluateLatestEntrySignal` → `runBacktest`) already
produces the full trade list with `entryTime`/`exitTime`/`type` — it was
just being discarded after extracting the latest trade.

Phase 3 v2 fixes this at the source: the evaluator now exposes a compact
`tradeWindows: [entrySec, exitSec, dirSign][]` (capped to the most recent
200 trades), the cron persists it into `latest_state_json`, and the batched
endpoint returns it. The browser forward-fills each member's windows across
the visible chart bars and sums them into a per-bar committee score.

### Executed Phase 3 — two-mode chart overlay

The `Show Score on Chart` button cycles three modes:

- **off** — no overlay.
- **current** — projects the live net committee score across all visible
  bars (step histogram, colored by sign). Available even before the worker
  is redeployed with `tradeWindows` support.
- **historical** — per-bar net vote reconstructed from each member's
  `tradeWindows`. Cross-timeframe alignment is implicit because windows
  are wall-clock seconds: a 1h member's window covers every 1m bar inside
  `[entrySec, exitSec)`. If no member has windows yet (worker not
  redeployed), the overlay is cleared rather than showing a misleading
  flat-zero histogram.

### Technical Tasks (executed)

1. `lib/signal-entry-evaluator.ts`: `EntrySignalEvaluationResult.tradeWindows`
   field + `compressTradeWindows(trades)` helper (caps to 200 most recent,
   emits `[entrySec, exitSec|null, dirSign]`).
2. `workers/entry-signal-worker.ts`: propagate `tradeWindows` through every
   `processSignalPayload` return path, persist into `latest_state_json`,
   and surface on the batched `/api/subscriptions/states` response.
3. `lib/signal-committee-overlay.ts`: pure `computeCommitteeOverlayScores`
   (Int32Array per-bar score) + `toOverlayPoints` adapter. O(members ×
   windows × bars); no per-bar allocations.
4. `lib/chart-manager.ts`: `setCommitteeScoreOverlay` / `removeCommitteeScoreOverlay`
   with targeted series ownership (does not wipe user indicators).
5. `lib/signal-committee-service.ts`: three-state `overlayMode` toggle,
   `renderScoreOverlay` handles both modes, `candleToSec` normalizes the
   chart's time shape (unix seconds / ms / ISO).
6. `lib/alert-service.ts`: `CommitteeMemberState.tradeWindows` field.

### Dependencies

- Phase 1 (membership + batched state) complete.
- Worker must be redeployed with the `tradeWindows` propagation for
  historical mode to show data. Current mode works on the existing worker.

### Risks / Blockers

- **`latest_state_json` size growth.** Adding up to 200 `[entrySec, exitSec,
  dirSign]` tuples per stream grows the JSON by a few KB per member. D1 row
  size limit is 1MB; with the 25-member UI cap this stays well under. The
  200-trade cap bounds the worst case.
- **Member/chart timeframe mismatch.** Windows are wall-clock seconds, so a
  member evaluated on 1h produces windows that correctly cover 60 1m bars
  each. No resampling needed.
- **No chart-performance risk.** `computeCommitteeOverlayScores` is one pass
  per member-window pair; 25 members × 200 windows × 5000 bars ≈ 25M simple
  comparisons, well under one frame.

### Validation / Testing Criteria

- `npm run typecheck` ✓
- `tests/signal-committee-overlay.spec.ts` ✓ (boundary inclusivity, open
  trades, multi-member sum, cross-timeframe coverage, malformed inputs,
  overlapping windows, point zipping).
- `tests/feature-dom-contracts.spec.ts` ✓.
- Manual: cycle the toggle through off → current → historical → off; in
  historical mode, confirm bars before any entry score 0, bars inside a
  member's window reflect the live sum.

### Exit Criteria

- Historical overlay matches hand-computed per-bar score on a small fixture.
- Toggling off fully removes the series.
- No typecheck or contract regressions.

---

## Phase 4 — Aggregate-score notifications (opt-in, default off)

### Objective

Optional Telegram alert when the committee score crosses a configured
threshold or flips sign.

### Scope (executed, 2026-06-20)

- New `committee_alert_rules` table (migration `0008`), one row per
  `committee_tag` (PK). Columns: `enabled`, `long_threshold`,
  `short_threshold`, `last_fired_score_sign` (hysteresis), `last_fired_at`.
- Worker-side aggregate pass in `scheduled()` after `runScheduledSubscriptions`:
  sums each tag's members' open-trade votes from `latest_state_json`, fires
  Telegram on threshold cross with sign-change hysteresis.
- Endpoints: `GET /api/committee-alert/rules`, `POST /api/committee-alert/rules`.
- Browser: `alertService.listCommitteeAlertRules` /
  `upsertCommitteeAlertRule`, plus UI in the committee tab (enable toggle,
  long/short threshold inputs, Save button).
- **Default off.** The migration does not seed a rule; a fresh deploy has no
  rules until the user opts in via the UI.

### Hysteresis (the spam guard)

A pure exported helper `decideCommitteeAlert(score, rule)` decides whether to
fire. The rule: fire only when the score's sign differs from
`last_fired_score_sign` AND the magnitude crosses the matching threshold.
After a fire, `last_fired_score_sign` is updated, so subsequent ticks on the
same side of zero never refire — even if the score climbs further. Refire
requires crossing back through zero to the opposite threshold.

### Technical Tasks (executed)

1. Migration `0008_committee_alert_rules.sql`.
2. Worker: `decideCommitteeAlert` (pure, exported, tested),
   `runCommitteeAlertPass` (cron-side runner), `handleCommitteeAlertRulesList`,
   `handleCommitteeAlertRulesUpsert`. Wired into `scheduled()` after the
   subscription pass.
3. `alertService.listCommitteeAlertRules` / `upsertCommitteeAlertRule`
   (graceful empty/null on old workers).
4. UI: section in `tab-signal-committee.html`, DOM contract extended, service
   `loadAlertRule` (after first reachable health check) + `saveAlertRule`.

### Dependencies

- Phase 1 task 2 (`latest_state_json` cached by cron) — the alert pass reads
  cached state, so it adds no per-tick backtest cost.

### Risks / Blockers

- **Telegram not configured.** If `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
  are missing, `sendTelegramText` throws, the failure is logged, and
  `last_fired_score_sign` is not updated — so the next eligible tick will
  retry. This is intentional: a transient Telegram outage should not lose
  the alert silently.
- **Multi-committee semantics.** Phase 4 aggregates per distinct
  `committee_tag`, so multi-tag deployments get independent rules. v1 UI
  only exposes the `default` tag.

### Validation / Testing Criteria

- `npm run typecheck` ✓
- `tests/entry-signal-worker.spec.ts` extended with:
  - `decideCommitteeAlert`: fire on threshold+sign-change, no refire while
    sign unchanged, refire on sign flip, no fire when disabled, no fire on
    zero score.
  - endpoint auth gating (GET + POST return 401 with token, 500 without DB).
- Manual: set threshold low, let cron run, confirm one Telegram message,
  confirm no repeat on the next tick.

### Exit Criteria

- Default-off behavior: fresh deploy has no rules until UI opt-in.
- Hysteresis prevents spam: a stuck score never fires twice.
- All validation commands pass.

---

## Post-Phase fix — chart overlay scope + multi-year coverage (2026-06-28)

Two defects surfaced after deployment, both fixed in the same pass:

### 1. Overlay summed unrelated pairs onto the chart

`renderScoreOverlay` was summing `tradeWindows` from every active committee
member regardless of symbol. A FETUSDT chart would read votes accumulated from
BTCUSDT, ETHUSDT, and every synthetic pair — the committee header badge's
whole-committee tally, accidentally applied to a single-symbol chart.

Fix: scope the overlay to members whose symbol (or synthetic leg) matches
`state.currentSymbol`, reusing the per-leg decomposition already used by
`aggregateLegScores` (long BASE/QUOTE -> +1 base leg, -1 quote leg on the
chart). New pure helper `chartOverlayVoteMultiplier(chartSymbol, member)` in
`lib/signal-committee-overlay.ts`. The committee header badge is unchanged
(it intentionally reflects the whole committee).

### 2. Older bars scored 0 (200-trade cap)

`compressTradeWindows` was capped at the most recent 200 trades. On a 4h chart
(~1k–2k trades/year) that only reached back ~2 months, so older bars had no
covering window and silently read 0. Symptom matched by Score Edge reports
showing `bars in market: 432, score=0 n=15623` on a 7-year chart.

Fix: raised `TRADE_WINDOWS_CAP` from 200 to 5000 (covers several years at
typical trade frequency; payload ~0.6 MB stays under D1's 1 MB row limit for
the documented ≤25-member committee). To keep overlay render time flat at the
larger cap, rewrote `computeCommitteeOverlayScores` from
O(members × windows × bars) to an events-based sweep
O(events log events + bars). Measured 29 ms at 25 members × 5000 windows ×
16 000 bars (250 000 events).

### Caveat — worker members need a redeploy

Both fixes live in browser-evaluated code paths. Local-synthetic members
(evaluator runs in-browser) pick up the changes immediately on reload.
Worker-evaluated members only get the larger `tradeWindows` cap after the
worker is redeployed with the updated `lib/signal-entry-evaluator.ts`; until
then their `latest_state_json` still carries the 200-window cap.

### Post-fix follow-up — synthetic candle limit (2026-06-28)

The cap raise above turned out not to be the active bottleneck for synthetic
committee members. Diagnostics on a 45-member synthetic committee showed every
member's `tradeWindowsRange.spanDays` ≤ ~75 days, regardless of
`tradeWindowsCount` (1–18). The strategy was never hitting the 5000-window
trade cap; it was being fed too few candles to produce older windows at all.

Root cause: `SYNTHETIC_WORKER_CANDLE_LIMIT = 500` in
`lib/signal-committee-service.ts`. The browser sends this `candleLimit` when
registering each synthetic pair via `upsertSubscription`, and the worker uses
it (read from D1 `signal_subscriptions.candle_limit`) to bound how many ratio
candles it fetches and feeds the strategy. 500 candles at 4h ≈ 83 days, so the
strategy literally had no data older than ~83 days to produce tradeWindows
for — matching the "score only shows for ~2 months" symptom exactly.

Fix: raised `SYNTHETIC_WORKER_CANDLE_LIMIT` from 500 to 2000 (~333 days at 4h).
The existing-member override path in `applyWorkerSyntheticRepairs` already
compares each D1 row's `candle_limit` against the constant and re-upserts rows
below it, so raising the constant migrates already-registered members on the
next browser refresh — no manual D1 backfill, no worker redeploy (the worker
reads `candle_limit` from D1, not from any worker-side constant).

Worker CPU/rate-limit budget: at 2000 candles × 2 legs × 25 members = 100k
klines per cron tick, split across 7 Binance API bases (~14k/base/min) — well
under the documented committee target.

### Validation

- `npm run typecheck` ✓
- `tests/signal-committee-overlay.spec.ts` ✓ (cap-raise regression, events-sweep
  correctness vs hand-computed scores, tie resolution, perf gate at 25 × 5000 ×
  16 000)
- existing committee specs unaffected ✓

---

# Open Assumptions and Unknowns

- **Option A vs Option B (membership tag).** Plan defaults to Option A
  (server-side `committee_tag` column). If migration overhead is undesirable,
  Option B (localStorage filter) is a documented fallback but breaks the
  "freshness after browser reset / other device" promise. Decide at task 1.
- **`latest_state_json` size.** The serialized state is small (a few hundred
  bytes per subscription). No truncation expected, but confirm against the
  D1 row-size practical limit during task 2 if the payload grows.
- **Phase 3 exit-signal availability.** `GET /api/stream/signals` returns
  entries only. Open-trade windows must be derived client-side from the
  latest state, or the endpoint extended. Flagged in Phase 3 risks; not
  blocking Phase 1.
- **Migration numbering.** Highest existing migration today is
  `0005_actionable_entry_signal_index.sql`. Confirm at implementation time
  that no in-flight branch has taken `0006`/`0007`.

# Out of Scope

- **Cross-symbol / synthetic-pair committee members.** The worker cannot
  evaluate them (`isWorkerSupportedStrategyKey` rejects them). Supporting
  them requires a browser-side evaluation path with its own state cache,
  which is a separate, larger plan. The Add button blocks them in v1.
- Multi-committee grouping with per-committee alert routing (Phase 4 treats
  all tagged members as one committee).
- Server-side persistence of UI prefs (they stay in localStorage via
  `lib/persisted-json.ts`).
- Live order execution from committee score (Execution Lab is the only
  execution surface and remains so).
- Rewriting Ensemble Lab to be cross-chart.
