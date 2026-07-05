# Batch Backtest Server-Side Execution Plan

> **Read me first — audit revisions.** This plan was audited after the first draft and corrected. The most important corrections to be aware of before implementing:
>
> 1. **The Rust engine is silently skipped in Node.** `isBrowser()` at `lib/backtest-executor.ts:469` gates the Rust attempt. Without an explicit fix (Step 4 of Implementation Order), server-side mode uses the TypeScript engine even when the user has Rust enabled. **This is a silent perf regression and a ship blocker.**
> 2. **Copy summary loses B&H and OPEN_SCORE sections** in server-side mode. The scalar-only wire transport means `buildBuyHoldRows` (reads `row.data`) and `computeOpenTradeAssetScores` (reads `row.result.trades`) no-op gracefully. This is accepted in v1 and must be documented, not silently shipped.
> 3. **Reattach is a 2s snapshot poll, not a stream tap.** The original draft floated a `/events` endpoint to tap the live NDJSON stream from a second connection. IBKR sync doesn't do this and neither should we — multi-subscriber writers are over-engineering for a single-user dev server.
> 4. **`lastResults` needs an explicit TTL release** on the server. The browser path got this for free (tab reload frees memory). Without a TTL, a user who runs 1000 pairs and walks away leaves ~5 GB pinned on the dev server.
> 5. **Loader parity is the highest-risk integration point.** Step 3 (parity test) gates all subsequent work. Do not skip.
>
> The body of the plan reflects these corrections inline.

## Purpose

Move the heavy Batch Backtest computation out of the browser tab and into the Vite dev-server (Node) process so 1000+ synthetic-pair runs stop OOM-ing the browser heap.

The browser keeps its current UX: same Run / Stop / Copy / Mine Timing buttons, same progress bar, same per-symbol rows streaming in. The browser tab holds only rendered scalars and DOM rows. Node holds the full OHLCV / signals / trades arrays.

The same machinery extends to Finder Universe runs in a follow-up (it shares the same pipeline shape), but this plan scopes the work to Batch Backtest to keep the change reviewable.

## Motivation

The browser OOM at ~1000 IBKR 4H synthetic pairs is intrinsic to correct synthetic-pair math. The pipeline must:

1. Load each leg at the seed interval (30m for a 4H target, ratio 8) so the base/quote ratio is computed from same-instant prices. See `scripts/lib/synthetic-pair.ts:148-180` — the `buildSyntheticPairDataset` comment explicitly documents that "ratio of extremes from different moments inflates the bar range by 3-18× for correlated legs."
2. Aggregate the ratio series to the target interval (4H).
3. Backtest each pair.
4. Hold the per-row `{data, signals, result.trades}` for the Mine Timing step.

So the 30m intermediates (~5–7 MB per leg × 70 unique legs ≈ 420–490 MB) and the per-pair artifacts (~5–10 MB × 1000 pairs ≈ 5–10 GB before Mine prune) are unavoidable inside one run. The shipped in-browser mitigations (cache cap reductions, post-eval array release, post-Mine prune — commit `6401a53`) only delay the OOM; they don't fix it.

A real PC has 16–64 GB of RAM. Node can use it directly. The browser tab is the wrong process for this workload.

## Assumptions And Unknowns

### Assumptions

- The user runs against the local Vite dev server (the same process that already hosts `/api/ibkr/sync`, `/api/backtest`, `/api/sqlite`, `/api/execution-lab`). No remote batch farm.
- The TS pipeline (`runBatchBacktest`, `executeBacktest`, `runBatchSyntheticStateMiner`, `buildSyntheticPairFromLegs`, `aggregateSyntheticBars`) is *mostly* transport-agnostic — `runBatchBacktest` already accepts `loadDataset` as an injected callback (the seam), and `runBatchSyntheticStateMiner` is pure TS, no I/O. **Caveat:** `executeBacktest` is async, calls `isBrowser()` at `lib/backtest-executor.ts:469` to gate the Rust engine attempt, and transitively imports browser-coupled modules via the default `loadDataset`. These gates must be addressed explicitly — see "Engine selection — the Rust-engine trap" below. The pipeline is *callable* from Node today (the existing `/api/backtest/:strategyKey/batch` endpoint proves it) but needs the fixes below to preserve browser-side parity.
- The browser-side `BatchBacktestService` callbacks (`setProgress`, `setStatus`, `onSymbolComplete`, `isCancelled`) translate losslessly across an NDJSON stream — each callback fires at most once per symbol and carries either a scalar update or one row's scalars.
- The user accepts a single in-flight batch run per dev server (same single-owner model as IBKR sync, `lib/ibkr-data/ibkr-data-vite-plugin.ts:1157`).
- Cancelled runs must release Node memory promptly (no zombie background work after Stop).

### Unknowns

- Whether the user wants to retain the in-browser execution path as a fallback (for "small batches, no dev-server batch infra needed") or replace it entirely. Default in this plan: **retain as fallback**, gated by a settings toggle. Cheap to remove later.
- Whether Finder Universe should ship in the same change or as a follow-up. Default in this plan: **follow-up**. The transport and plugin shape are identical; Finder adds the multi-strategy loop and OOS pass on top.
- The realistic Node heap ceiling. The dev server runs Vite plus other plugins; if the user is also running an IBKR sync concurrently, both compete for the same Node process. Recommendation: instruct users to start the dev server with `NODE_OPTIONS=--max-old-space-size=16384` (or higher) when batch is in use. Document this in `README.md` and the new `docs/batch-backtest-server-side.md` (the non-plan doc that ships with the feature).
- Whether to surface a "reattach after reload" path. IBKR sync has one (`reattachToInProgressSync` at `lib/ibkr-data/ibkr-data-service.ts:62`, polls `GET /api/ibkr/sync/status`). It is desirable for long batch runs but can ship in v2. Default in this plan: **ship reattach in v1** because batch runs are typically longer than IBKR syncs and a tab reload during a 30-minute run is realistic.

## Architecture

### Shape (1:1 with IBKR sync)

```
Browser                              Vite dev server (Node)
───────                              ──────────────────────
BatchBacktestService.runBatch()
  ─── POST /api/batch-backtest/run ──►  acquires owner lock
                                         begins NDJSON stream
                                         runBatchBacktest(input, callbacks)
                                            │
                                            │  for each symbol:
                                            │    load (via Node-side loader)
                                            │    executeBacktest
                                            │    stream {type:"symbol", row}
                                            │
                                         stream {type:"done", summary}
  ◄── NDJSON line-by-line ───────────
  consumeNdjsonStream(handlers)
    onSymbol → appendResultRow
    onStart / onProgress / onDone / onFatal
  Stop button
  ─── POST /api/batch-backtest/stop ──►  bumps owner-gen; runner bails at
                                         next isCancelled() check
```

This is structurally identical to `handleSyncRequest` at `lib/ibkr-data/ibkr-data-vite-plugin.ts:1151-1202`. Copy that pattern verbatim.

### Streaming event shape

Mirror the IBKR event taxonomy (defined as `IbkrStreamEvent` at `lib/ibkr-data/ibkr-data-service.ts:8-13`):

| `type`       | Fields                                                              | When                                |
|--------------|---------------------------------------------------------------------|-------------------------------------|
| `start`      | `total`, `interval`, `strategyKey`                                  | Run begins                          |
| `progress`   | `percent`, `text`, `status`                                         | Each symbol's load+backtest starts  |
| `symbol`     | `index`, `total`, `row` (the `BatchBacktestSymbolResult` scalars)   | One symbol completes                |
| `symbol_failed` | `index`, `total`, `symbol`, `error`                             | Load or backtest throws             |
| `done`       | `ok`, `cancelled`, `interval`, `totals`, `summary`                  | Run finishes (clean or cancelled)   |
| `fatal`      | `error`                                                             | Unhandled exception                 |

**Critical contract:** the `row` sent in `symbol` events must contain ONLY scalars. The `data`, `signals`, and `result.trades` arrays stay in Node. The browser reconstructs a `BatchBacktestSymbolResult` with `data`/`signals` left `undefined`. This is what makes the browser memory bounded regardless of pair count.

**Consequence — Copy-after-run is degraded in server-side mode.** `formatBatchOverallSummary` (the Copy handler, `lib/batch-backtest/batch-backtest-service.ts:561`) calls `buildBuyHoldRows` which reads `row.data` (line 741 → `computeBuyAndHoldPct(row.data)`), and `computeOpenTradeAssetScores` which reads `row.result.trades` (line 959). With scalar-only wire transport, both helpers gracefully no-op: `computeBuyAndHoldPct(undefined)` returns `null` at line 924, `buildBuyHoldRows` skips on `bh === null` (line 742), and `computeOpenTradeAssetScores` skips on `trades.length === 0` (line 960). So the Copy summary in server-side mode renders **without the B&H rows block and without the OPEN_SCORE line**. This is the same graceful degradation as the post-Mine prune (commit `6401a53`) and must be:
- Documented in `docs/batch-backtest-server-side.md`.
- Surfaced as a one-line note in the Copy output itself: `"Copy summary excludes B&H and OPEN_SCORE in server-side mode"` or similar.
- Accepted by the user explicitly before shipping this mode. If losing those sections is a blocker, two remedies exist: (a) add `POST /api/batch-backtest/copy-summary` that computes the full summary server-side and returns just the formatted text; or (b) send `firstClose`/`lastClose` and the open-trade summary as extra scalar fields in the `symbol` event so the browser-side `buildBuyHoldRows` and `computeOpenTradeAssetScores` can be reimplemented to consume scalars instead of arrays. **Default in this plan: ship v1 without those sections and document the gap. (a) or (b) are follow-ups if the user requires them.**

The browser-side Mine button must be gated on "server holds artifacts" (a `serverHasArtifacts: true` flag in the `done` event) rather than on `row.data !== undefined` as it is today (`lib/batch-backtest/batch-backtest-service.ts:445`).

### Cancellation

Two-layer, mirroring IBKR sync:

1. **Owner-generation lock** at plugin scope (the IBKR pattern at `ibkr-data-vite-plugin.ts:1157-1158, 1081`). `POST /api/batch-backtest/stop` force-bumps the generation; `runBatchBacktest`'s injected `isCancelled` callback reads the same generation and returns true once bumped.
2. **`AbortController`** for in-flight dataset loads, exactly as the runner already does at `lib/batch-backtest/batch-backtest-runner.ts:148, 176`. The plugin owns the controller and calls `.abort()` on Stop.

Both layers are required because the owner lock catches the loop between awaits, while the AbortController cancels the active `loadDataset` mid-fetch.

### Engine selection — the Rust-engine trap (critical)

`isBrowser()` at `lib/backtest-executor.ts:469` returns `typeof document !== "undefined"`. In Node this is `false`. `shouldAttemptRust("auto", false)` at line 477-479 returns `false` for `engineMode: "auto"` *unless* `engineMode === "rust_preferred"`. So in server-side mode with `engineMode: "auto"` (which is what `batch-backtest-runner.ts:280` passes), **the Rust engine is silently skipped even when the user has it enabled**.

This is a silent perf regression vs. browser mode for any user who runs the Rust engine. It must be addressed before shipping.

**Fix options (pick one):**

1. **Server-side Rust client.** Construct a Node-side equivalent of `rustEngine` (`lib/rust-engine-client.ts`) that uses Node's `fetch` (Node 18+) instead of browser `fetch`. The Rust client is already HTTP-based — works unchanged from Node. Then thread it into `executeBacktest` via a new `engineClient` parameter on `BacktestExecutorRequest` (or via module-scope injection). When `executeBacktest` runs in Node and the user has Rust enabled, it uses the injected client. Update `shouldAttemptRust` to also check `engineMode === "auto"` when an `engineClient` is injected (since the `isBrowser()` gate is no longer the right discriminator).

2. **Force `engineMode: "rust_preferred"` in the server-side runner** when the user has Rust enabled, bypassing `isBrowser()`. Smaller change, less abstraction, but conflates "user preference" with "execution mode."

3. **Accept the regression and document it.** Server-side mode uses the TypeScript engine. Users who need Rust stay on browser-side mode. **Not recommended** — defeats the purpose of moving heavy work off-browser.

**Default in this plan: Option 1.** It's the cleanest seam and preserves user intent. Add a step in Implementation Order for this work, plus a parity test: same pair, same params, run in browser-side mode with Rust → record backtest result; run in server-side mode with Rust → assert results match.

**The same issue affects the data loader.** `DataFetcher.fetchDataDetached` and friends may have their own `isBrowser()` checks — audit them when building `server-batch-data-loader.ts` and apply the same fix.

### Reattach after reload

Use **snapshot polling**, not a multi-subscriber stream tap. IBKR sync's reattach (`lib/ibkr-data/ibkr-data-vite-plugin.ts:1346-1360` `/api/ibkr/sync/status` returning `syncRunState`) does NOT tap the original NDJSON stream from a second HTTP connection. It snapshots the in-progress run state and lets the browser poll. This plan does the same — a multi-subscriber writer is over-engineering for a single-user dev server.

`GET /api/batch-backtest/status` returns a snapshot:
```json
{
  "ok": true,
  "running": boolean,
  "run": {
    "total": number,
    "completed": number,
    "failed": number,
    "startedAt": number,
    "interval": string,
    "strategyKey": string,
    "currentSymbol": string | null,
    "rows": BatchBacktestSymbolResult[]   // scalar-only rows emitted so far
  } | null,
  "miner": { "running": boolean, ... } | null
}
```

`BatchBacktestService.init()` (registered via `lib/app-bootstrap.ts:345` `registerLazyFeature("batch-backtest", ...)`) calls this once on tab open. If `running`, the service:
1. Renders the `rows` accumulated so far.
2. Sets a "Run in progress on server — observing" status.
3. Long-polls `/status` every 2s (matches `reattachToInProgressSync`'s poll cadence at `ibkr-data-service.ts:62`).
4. Stops polling when `running === false`, then renders the final `done` summary.

This is less granular than the live NDJSON stream (you see updates every 2s instead of per-symbol), but it's the IBKR-proven pattern and avoids all multi-subscriber writer complexity. **No `/api/batch-backtest/events` endpoint is built.** Removed from the original plan after auditing how IBKR sync actually reattaches.

### Miner

`runBatchSyntheticStateMiner` (`lib/batch-backtest/batch-synthetic-state-miner.ts:218`) is pure TS, synchronous, no I/O. It runs server-side unchanged.

`POST /api/batch-backtest/mine` (NDJSON stream) reuses the in-memory `lastResults` retained by the run handler (still in scope on the plugin), passes artifacts to `runBatchSyntheticStateMiner`, and streams `{type:"verdict", verdict}` events as the miner produces them. Final `{type:"done", summary}` carries the totals.

**Miner ↔ Run lock interaction:** a new Run cannot start while Mine is in flight, and a new Mine cannot start while a Run is in flight. Both share the same owner-lock (separate from IBKR sync's lock). The browser-side fingerprint guard (`batch-backtest-service.ts:235-240`) already rejects "Mine after settings changed"; the server-side Mine endpoint applies the same check against the stored run fingerprint before starting.

**Memory release triggers for `lastResults`:** the plugin nulls its `lastResults` reference on any of:
1. Successful Mine completion (after streaming `done`).
2. A new Run starting (`POST /run` resets `lastResults = []` before the run begins).
3. **A bounded TTL** (default: 10 minutes after the Run's `done` event with no Mine click). Without this, a user who runs 1000 pairs, doesn't click Mine, and walks away leaves ~5 GB pinned on the dev server indefinitely. The browser path doesn't have this issue (tab reload frees everything); the server path needs the explicit TTL. The TTL is configurable via `BATCH_ARTIFACT_RETENTION_MS` at plugin scope.

This mirrors the in-browser post-Mine prune (commit `6401a53`) but moved server-side, plus the TTL defense-in-depth that browser-side got for free.

### Settings toggle

Add `batchExecutionMode` to settings with values `"browser" | "server"`. Default `"server"` (the whole point). UI: a small radio under the Batch tab header or in Settings → Backend Engine, alongside the existing Rust engine toggle (`html-partials/tab-settings-section-execution.html`). When `"browser"`, today's code path runs unchanged.

Register the setting in both DOM-contract systems per AGENTS.md (`BACKTEST_DOM_SETTING_IDS` in `lib/backtest-settings-resolver.ts` and `BACKTEST_SETTINGS_DOM_CONTRACTS` in `lib/backtest-settings-dom-contract.ts`). Add a feature-local `lib/batch-backtest/batch-backtest-dom.ts` entry if the toggle lives in the Batch tab.

## Files To Add Or Change

### New files

1. **`lib/batch-backtest/batch-backtest-vite-plugin.ts`** — the plugin. Pattern: `{ name, configureServer, configurePreviewServer }` matching `ibkr-data-vite-plugin.ts:1363-1371`. Routes mounted at `/api/batch-backtest/*`:
   - `POST /api/batch-backtest/run` — NDJSON stream, calls `runBatchBacktest`
   - `POST /api/batch-backtest/stop` — bumps owner gen + aborts
   - `GET  /api/batch-backtest/status` — reattach poll
   - `GET  /api/batch-backtest/events` — (optional v1 alternative) stream tap
   - `POST /api/batch-backtest/mine` — NDJSON stream, calls `runBatchSyntheticStateMiner`
   - `POST /api/batch-backtest/mine/stop` — bumps miner owner gen

   Plugin holds module-scope state: `runOwner`, `runOwnerGen`, `runState` (snapshot), `lastResults` (retained for Mine), `abortController`. Same shape as IBKR's `syncOwner` / `syncOwnerGen` / `syncRunState` triplet.

2. **`lib/batch-backtest/server-batch-data-loader.ts`** — Node-side equivalent of `lib/batch-backtest/batch-backtest-loader.ts:77-149` (`loadBatchDataset`). The existing loader goes through the browser-bound `dataManager` singleton (`lib/data-manager.ts:794`), which cannot run in Node because `DataManager` constructs a `DataFetcher` with UI callbacks that call `uiManager.showToast(...)` etc. (lines 64-65).

   The recipe is in `lib/data/data-fetcher.ts:178-192` (`DataFetcher.fetchDataDetached`): construct a fresh `DataFetcher` with empty `{}` UI callbacks and call `fetchDataWithOptions`. Mirror `loadBatchDataset`'s shape (the synthetic-leg / pair-cache layer, the stale-fragment guard, the marked-symbol routing) but instantiate `DataFetcher` directly instead of going through `dataManager`.

   Reuse `SyntheticLegCache` from `lib/batch-backtest/synthetic-leg-cache.ts` for the leg/pair LRU (caps already lowered in commit `6401a53`). Do not share cache instances with the browser path — Node and browser are separate processes with separate module scopes.

3. **`docs/batch-backtest-server-side.md`** — the user-facing doc (separate from this plan). Covers: when to use server-side mode, how to start the dev server with `NODE_OPTIONS=--max-old-space-size=...`, the settings toggle, the reattach behavior, and the "stop vs cancel vs reload" semantics.

4. **`tests/batch-backtest-server-plugin.spec.ts`** — exercises the plugin's `processRunBatch` (the function factored out of the HTTP handler, mirroring `processSyncBatch` at `ibkr-data-vite-plugin.ts:1037`). Uses a stubbed `loadDataset`. Asserts: stream event sequence, owner-lock semantics, cancellation propagation, miner artifact retention and release.

### Modified files

5. **`vite.config.ts`** (lines 340-351) — register `batchBacktestVitePlugin()` in the plugin list.

6. **`lib/batch-backtest/batch-backtest-service.ts`** — split `runBatch()` into two paths gated on `batchExecutionMode`:
   - `"browser"`: today's path, unchanged.
   - `"server"`: `POST /api/batch-backtest/run`, consume NDJSON via `consumeNdjsonStream` (the helper at `lib/ibkr-data/ibkr-data-service.ts:288` — extract to `lib/ndjson-stream.ts` so both features share it).
   
   The browser-side `lastResults` is populated from `symbol` events with **scalars only** (no `data`, `signals`, `result.trades`). Mine button is gated on `serverHasArtifacts` flag from the `done` event (or from `GET /status`), not on `row.data`.

7. **`lib/ndjson-stream.ts`** (new, extracted from `ibkr-data-service.ts:288-325`) — shared `consumeNdjsonStream(body, handlers)` helper. `ibkr-data-service.ts` switches to import from here.

8. **`lib/batch-backtest/batch-backtest-types.ts`** (or new `batch-backtest-stream-types.ts`) — `BatchStreamEvent` discriminated union, exported from the plugin module and imported by the browser service.

9. **`html-partials/tab-batch-backtest.html`** + matching `*-dom.ts` contract — add the `batchExecutionMode` toggle (radio or checkbox). Register the new DOM id in the feature-local contract and the global barrel per AGENTS.md "UI DOM contracts".

10. **`lib/backtest-settings-resolver.ts`** — add `batchExecutionMode` to `BACKTEST_DOM_SETTING_IDS`.

11. **`lib/backtest-settings-dom-contract.ts`** — add `batchExecutionMode` to `BACKTEST_SETTINGS_DOM_CONTRACTS` with `parser: "string"`, `defaultValue: "server"`, `legacyAliases: []`.

12. **`tests/feature-dom-contracts.spec.ts`** — extend to cover the new DOM id.

13. **`AGENTS.md`** — under "Modify Batch Backtest" (the section added in commit `6401a53` after "Memory budget"), document: the server-side mode, the Node heap requirement, the `processRunBatch` factoring, the `serverHasArtifacts` flag, and the rule that the `row` sent over the wire must never contain array fields.

14. **`README.md`** — add a "Server-side Batch Backtest" subsection under the existing architecture or usage section. Cross-link from the Performance section if there is one.

15. **`lib/backtest-executor.ts`** — Step 4 (Rust-engine trap). Add the `engineClient` injection parameter (or module-scope setter) so `shouldAttemptRust` no longer relies on `isBrowser()` when a server-side client is available. Touches `shouldAttemptRust` at line 473-480 and the call site at line 319. Audit for other `isBrowser()` branches in the same file that affect engine selection.

16. **`lib/rust-engine-client.ts`** — Step 4. The existing class is already HTTP-based and works from Node 18+ unchanged (no `window`/`document` references — verified). Confirm by importing it directly into the plugin and instantiating with the same `127.0.0.1:3030` default URL. If anything fails, the fix is to swap browser `fetch` for Node's global `fetch` (no code change needed on Node 18+; the existing code already uses the global `fetch`).

### Untouched (important — these are NOT ported)

- `lib/batch-backtest/batch-backtest-runner.ts` — `runBatchBacktest` runs unchanged in Node. It already accepts `loadDataset` as a callback, which is the seam.
- `lib/batch-backtest/batch-synthetic-state-miner.ts` — pure TS, runs unchanged.
- `lib/batch-backtest/batch-backtest-dom.ts` — DOM ids stay the same; only one new id is added (the mode toggle).
- `lib/finder/*` — out of scope for v1.

## Validation Habits

Per AGENTS.md, run after each meaningful step:

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` (after DOM contract changes)
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-copy.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-synthetic-state-miner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\batch-backtest-server-plugin.spec.ts` (new)
- `npm run test`
- Manual smoke: start dev server with `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run a 50-pair batch in browser mode (regression), then server-side mode (parity), then 1000-pair batch in server-side mode (the goal). Confirm: progress streams, Stop works, Copy produces identical summary, Mine Timing produces verdicts, reload mid-run reattaches.

## Implementation Order (Suggested)

Each step is independently shippable; stop after any of them if scope tightens.

1. **Extract `consumeNdjsonStream` to `lib/ndjson-stream.ts`** and migrate `ibkr-data-service.ts` to import it. Pure refactor, no behavior change. Verify: IBKR sync still works.
2. **Build `server-batch-data-loader.ts`** — the Node-side `loadBatchDataset` equivalent. Construct a `DataFetcher` directly (recipe at `lib/data/data-fetcher.ts:178-192`) instead of going through the browser-bound `dataManager` singleton.
3. **Parity test (gate).** Load the same IBKR 4H synthetic pair (e.g. `AAPL•+MSFT•`) via the browser loader and via the new server loader, assert bar-for-bar equality (same length, same timestamps, same OHLCV). Also test a real (non-synthetic) symbol like `BTCUSDT`. **Do not proceed to step 4 until this passes.** This is the single highest-risk integration point — if the server loader diverges, every downstream result is wrong.
4. **Engine selection fix (Rust-engine trap).** Construct the server-side Rust client, thread it into `executeBacktest`, update `shouldAttemptRust` so `engineMode: "auto"` with an injected `engineClient` no longer requires `isBrowser()`. Add a parity test: same pair + params in browser-side (with Rust) vs server-side (with Rust), assert backtest result equality. **Block on this before any user-facing rollout** — silent Rust skip is the worst kind of regression.
5. **Build the plugin's run path** — `processRunBatch` factored out of the HTTP handler (mirror `processSyncBatch` at `ibkr-data-vite-plugin.ts:1037`), `POST /run` + `POST /stop` + `GET /status`, owner-lock semantics, artifact TTL. Test with stubbed loader.
6. **Wire the plugin into `vite.config.ts`** and add a `curl`-level smoke test against `/api/batch-backtest/run`.
7. **Browser-side `BatchBacktestService`** server-side branch + `batchExecutionMode` toggle. Default to `"server"`. Manual smoke at 50 pairs (compare result rows to an equivalent browser-side run). At this stage the Mine button stays disabled (server has artifacts, browser doesn't).
8. **Mine endpoint** — `POST /mine` reusing `lastResults` retained by the run handler. Stream verdicts. Shared owner-lock with Run (Step 5).
9. **Reattach** — `GET /status` snapshot poll on `BatchBacktestService.init()` (the lazy feature init at `lib/app-bootstrap.ts:345`). 2s cadence. No `/events` stream tap.
10. **Docs** — `docs/batch-backtest-server-side.md`, AGENTS.md update (Memory budget section), README subsection. Document the Copy-summary degradation and the `NODE_OPTIONS` heap requirement prominently.

## Out Of Scope (Explicit)

- **Finder Universe server-side.** Same shape, more state (multi-strategy loop, OOS pass, prepared-data cache). Follow-up plan after this one ships.
- **Persistent batch worker across dev-server restarts.** A run in flight when the dev server restarts is lost; user re-runs. If durability matters later, a separate `npm run batch:worker` Node process plus a queue file is the right shape (Option 3 in the original discussion) — not worth it for v1.
- **Multi-tenant / concurrent runs.** Single-owner lock, one run at a time. Same as IBKR sync.
- **Rust engine changes.** The Rust server itself (`trading-engine` at `127.0.0.1:3030`) needs no changes. But the *client-side wiring* must change — `isBrowser()` currently gates the attempt (see "Engine selection — the Rust-engine trap" above). This work is **in scope** as Step 4 of Implementation Order, not out of scope.
- **Removing the in-browser path.** Keep it as a fallback for small batches and for environments without the dev server (e.g. opened from a built `vite preview`).

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| **Rust engine silently skipped server-side** (the trap above) | Address in dedicated step before any production use. See "Engine selection — the Rust-engine trap." Option 1 (server-side Rust client + injected `engineClient`) is the default. |
| Node dev server OOMs instead of browser | Document `NODE_OPTIONS=--max-old-space-size=16384`. The dev server is a long-running process; if it crashes, the user loses HMR too. Make this prominent in docs. The artifact TTL (10 min default) is the safety net for orphaned runs. |
| User opens two tabs, both try to start a batch | Single-owner lock returns `409 Conflict` from `/run` if a batch is in flight. Browser service shows "Batch already running in another tab" status. Same model as IBKR sync. |
| Tab reload mid-run loses already-rendered rows | Reattach polls `/status` every 2s, gets snapshot including `rows` accumulated so far. Rows already emitted are in `runState.rows`; the reattach response includes them. Granularity is 2s (not per-symbol), accepted tradeoff. |
| Mine Timing artifacts get GC'd before Mine runs | Plugin retains `lastResults` until Mine runs OR a new run starts OR the artifact TTL (default 10 min) elapses. Browser-side fingerprint guard still applies. The TTL is the new defense-in-depth that browser-side got for free (via tab reload). |
| Mine Timing artifacts hold ~5 GB on server indefinitely after a 1000-pair run | The TTL release trigger above handles the "user walked away" case. Document the TTL value prominently so the user knows when to expect release. |
| Run and Mine collide | Shared owner-lock: a new Run cannot start while Mine is in flight and vice versa. Both reset `lastResults` defensively on start. |
| Server-side `loadBatchDataset` produces different OHLCV than browser-side | Both must use the same `DataFetcher` router → same providers → same aggregation. **Add a parity test as Step 2.5:** load the same IBKR 4H synthetic pair both ways, assert bar-for-bar equality. Block on this before any further work. |
| **Copy summary loses B&H and OPEN_SCORE sections** (server-side scalar-only transport) | Documented consequence, accepted in v1. Two follow-up remedies available if user requires full Copy: server-side `/copy-summary` endpoint, or extend `symbol` event with `firstClose`/`lastClose`/open-trade summary scalars. |
| `consumeNdjsonStream` extraction breaks IBKR sync | Step 1 is a pure refactor with no logic change. Run `tests/ibkr-price-data.spec.ts` after extraction. |
| DOM contract drift (new `batchExecutionMode` id) | Register in both `BACKTEST_DOM_SETTING_IDS` and `BACKTEST_SETTINGS_DOM_CONTRACTS`. Run `tests/feature-dom-contracts.spec.ts`. Per AGENTS.md "Common Failure Modes". |
| Stream blocks event loop during heavy `executeBacktest` | The runner already yields via `await` per symbol (it's async). Confirm `processRunBatch` doesn't accidentally wrap the whole loop in one synchronous block. |

## Acceptance Criteria

A run is considered successful when:

1. A 1000-pair IBKR 4H synthetic batch completes server-side without browser-tab OOM and without dev-server crash (with `NODE_OPTIONS=--max-old-space-size=16384`).
2. Progress streams to the browser in real time (≤250 ms latency, matching the existing `UNIVERSE_UI_UPDATE_MIN_MS` budget at `lib/finder/finder-runner-universe.ts:55`). Reattach polls at 2s cadence (accepted tradeoff).
3. Stop cancels the run within one symbol's worth of work (the existing per-iteration `isCancelled` check).
4. **Copy produces the same summary as an equivalent in-browser run, EXCEPT** the B&H rows section and OPEN_SCORE line are absent in server-side mode. This degradation is documented in the user-facing docs and surfaced in the Copy output itself. The remaining summary sections (medians, profitable/losing rows, concentration, robustness) match exactly.
5. **Rust engine parity.** Same pair, same params, with Rust enabled: backtest result in server-side mode matches browser-side mode to the last decimal. (Without this, server-side mode is silently slower for Rust users — a blocker.)
6. **Loader parity.** Same IBKR 4H synthetic pair loaded via server loader and browser loader: bar-for-bar identical (length, timestamps, OHLCV).
7. Mine Timing runs server-side and produces verdicts; browser renders them unchanged. A new Run cannot start while Mine is in flight, and vice versa.
8. Reload the tab mid-run → service reattaches via `/status` poll and continues rendering rows (2s granularity).
9. Browser DevTools memory snapshot after a completed 1000-pair server-side run shows the tab well under 500 MB (vs ~5+ GB in-browser today).
10. **Node dev-server memory after a completed run + Mine + 10-minute TTL** returns to baseline (no orphaned `lastResults`). Verified via `process.memoryUsage().heapUsed` log before run start, after run done, after Mine done, after TTL.
11. Switching `batchExecutionMode` to `"browser"` still runs an in-browser batch end-to-end (no regression to today's path).
12. `npm run typecheck` clean, `npm run test` 165+/165+ pass.

## Reference: Existing Patterns To Copy Verbatim

- NDJSON writer: `lib/vite-http-utils.ts:42-81` `beginNdjsonStream`.
- NDJSON reader: `lib/ibkr-data/ibkr-data-service.ts:288-325` `consumeNdjsonStream` (extract to `lib/ndjson-stream.ts` in step 1).
- Owner-lock + cancel pattern: `lib/ibkr-data/ibkr-data-vite-plugin.ts:1151-1202` `handleSyncRequest` + `lib/ibkr-data/ibkr-data-vite-plugin.ts:1329-1344` `/api/ibkr/stop`.
- Reattach poll: `lib/ibkr-data/ibkr-data-service.ts:62` `reattachToInProgressSync` + `lib/ibkr-data/ibkr-data-vite-plugin.ts:1346-1360` `/api/ibkr/sync/status`.
- Plugin object shape: `{ name, configureServer, configurePreviewServer }` per `lib/ibkr-data/ibkr-data-vite-plugin.ts:1363-1371`.
- Vite plugin registration list: `vite.config.ts:340-351`.
- Server-side data fetcher recipe: `lib/data/data-fetcher.ts:178-192` `DataFetcher.fetchDataDetached`.
- Batch runner (the function being hosted): `lib/batch-backtest/batch-backtest-runner.ts:138-330` `runBatchBacktest`.
- Miner (server-ready): `lib/batch-backtest/batch-synthetic-state-miner.ts:218` `runBatchSyntheticStateMiner`.

## Concrete First Patch (Step 1 Only, Refactor)

To anchor the work, step 1 should produce exactly this diff:

- Move `consumeNdjsonStream` and its `NdjsonHandlers` type from `lib/ibkr-data/ibkr-data-service.ts:288-325` to a new `lib/ndjson-stream.ts`.
- Make the handler type generic over the event union so it's reusable: `consumeNdjsonStream<T>(body, handlers: NdjsonHandlers<T>)`.
- Update `ibkr-data-service.ts` to import from the new location.
- Run `tests/ibkr-price-data.spec.ts` and confirm no regression.

This is a no-behavior-change refactor that proves the shared helper is ready for the new plugin to consume.
