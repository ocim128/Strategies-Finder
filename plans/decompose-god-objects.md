# Priority 1: Decompose God-Object Services

## Purpose

Four service classes have grown into single-responsibility violations that slow every
change touching them. Each file mixes DOM rendering, business logic, event binding, data
orchestration, and export concerns in one class. This plan describes how to split each
into focused modules without changing runtime behavior.

The goal is **not** to rewrite logic. Every split is an extraction: move methods and
their associated fields into a new file, then delegate from the original class. The
original singleton keeps its public API intact so no consumer needs to change until a
later pass.

---

## Guiding Principles

1. **Behavior-preserving extraction only.** No logic changes, no renames of exported
   symbols, no new abstractions. Move code, wire delegation.
2. **One domain per file after split.** DOM rendering, business logic, event binding,
   and export each land in their own file.
3. **Original singleton stays as thin facade.** The exported singleton keeps its public
   methods but delegates to the extracted modules. Consumers import the same name.
4. **Fields travel with their methods.** When methods that read/write specific private
   fields move to a new module, those fields move too. The original class holds a
   reference to the new module's state if it still needs to read/write shared data.
5. **Incremental and reversible.** Each file split can be done and validated
   independently. If a split introduces a regression it can be reverted without
   affecting the other three files.

---

## File 1: `lib/strategy-ensemble-service.ts`

### Current State

| Metric | Value |
|--------|-------|
| Lines | 2,172 |
| Methods | 87 (1 public, 86 private) |
| Private fields | 13 instance + 3 static readonly |
| Imports | 82 from 30 modules |
| Exported singleton | `strategyEnsembleService` |

### Identified Responsibility Domains

| Domain | Method Count | Purpose |
|--------|-------------|---------|
| Event binding | 1 method (220 lines) | Wires every button, select, and click handler |
| DOM rendering & UI sync | 19 methods | Populates selects, renders config rows, syncs status messages |
| Target picker UI | 4 methods | Target picker dropdown, filter, toggle |
| Context selection & filtering | 9 methods | Checkbox management, shift-click range, family selection |
| Ensemble evaluation | 6 methods | Core `run()` + engine dependency assembly |
| Polymarket bridge (run + load) | 5 methods | Polymarket ensemble run, config/veto/override backtests |
| Polymarket UI readers | 3 methods | Reads DOM for conflict policy, direction slice, policy result |
| Label / description helpers | 7 methods | Human-readable descriptions for UI labels |
| Recipe management (build/save/load) | 14 methods | Builds recipes from run results, saves, loads previews |
| Recipe backtest loading | 5 methods | Runs backtests for saved recipes with Polymarket attachment |
| Export (download / copy / clipboard) | 4 methods | Bridge script download, env snippet copy |
| Recipe CRUD | 1 method | Delete recipe |
| Snapshot / cloning | 2 methods | Clone config snapshots |
| State invalidation | 2 methods | Invalidate run context, clear preview |
| UI value readers | 1 method | Read min samples from DOM |

### Proposed Module Split

#### 1a. `lib/strategy-ensemble-engine.ts` (already exists, but currently a utility module)

**Purpose:** Pure ensemble evaluation orchestration — no DOM, no events.

**Methods to move in:**
- `run()` — the main ensemble evaluation entry point
- `prepareCandles()`
- `buildEngineDeps()`
- `buildRulesRuntime()`
- `yieldToUi()`

**Fields to move in:**
- `runContext` (the frozen run result)

**Depends on:** state (for ohlcvData), strategy-ensemble-engine utilities, strategy-ensemble-rules.

**Coupling note:** `buildRulesRuntime()` calls `this.yieldToUi()` and `this.updateStatus()` on the service. After extraction, these must be injected as callbacks (e.g., `{ yieldToUi: () => ..., updateStatus: (msg) => ... }`). The static constants `MAX_RULE_VALIDATION_CANDIDATES` and `MAX_RULE_BUILDER_ROWS` are also referenced — these stay on the service and are passed as parameters.

**Why:** The core ensemble `run()` is the highest-value business logic. Isolating it
makes it testable without DOM and reusable by non-UI callers (e.g., workers, scripts).

---

#### 1b. `lib/strategy-ensemble-polymarket-runner.ts` (new)

**Purpose:** Polymarket ensemble run orchestration — the Polymarket parallel of `run()`.

**Methods to move in:**
- `runPolymarket()`
- `attachPolymarketOutcomesToBacktestResult()`
- `loadPolymarketConfigBacktest()`
- `loadPolymarketVetoPairBacktest()`
- `loadPolymarketOverridePairBacktest()`
- `requirePolymarketRunContext()`
- `getSelectedPolymarketConflictPolicy()`
- `getSelectedPolymarketDirectionSlice()`
- `getSelectedPolymarketPolicyResult()`

**Fields to move in:**
- `lastPolymarketRunResult`
- `lastPolymarketSelection`
- `lastPolymarketOutcomes`

**Why:** Polymarket has its own run lifecycle, its own result state, and its own
backtest loading paths. Mixing it with the main ensemble run adds branching complexity.
Isolating it also aligns with the existing `strategy-ensemble-polymarket-engine.ts`
and `strategy-ensemble-polymarket-renderer.ts` pattern.

---

#### 1c. `lib/strategy-ensemble-recipe-builder.ts` (new)

**Purpose:** Recipe construction — builds recipe objects from current run state.

**Methods to move in:**
- `buildConflictFilterRecipeFromCurrentRun()`
- `buildBestVetoRecipeFromCurrentRun()`
- `buildVetoRecipeFromPair()`
- `buildSecondaryOverrideRecipeFromCurrentRun()`
- `buildOverrideRecipeFromPair()`
- `buildBestSideOwnerRecipeFromCurrentRun()`
- `buildSelectedPolicyRecipeFromCurrentRun()`
- `buildUniqueSignalRecipeName()`
- `buildRecipeMetricsFromPolicyResult()`
- `buildDirectionSliceRecipeSuffix()`
- `cloneStrategyConfigSnapshot()`
- `loadRequiredStrategyConfigSnapshot()`

**Why:** Recipe building is pure data transformation with no DOM dependency. It is the
largest single group by method count (12 methods) and is completely independent of UI.
Extracting it reduces the ensemble service by ~200 lines of pure logic and makes recipe
construction testable in isolation.

---

#### 1d. `lib/strategy-ensemble-recipe-runner.ts` (new)

**Purpose:** Execute backtests for saved recipes — the "replay" path.

**Methods to move in:**
- `loadRecipeBacktest()`
- `loadRecipeBacktestWithOptions()`
- `loadConflictFilterRecipePreview()`
- `loadConflictFilterBacktest()`
- `loadBestVetoBacktest()`
- `saveConflictFilterRecipe()`
- `saveBestVetoRecipe()`

**Why:** Recipe replay is a distinct workflow from recipe construction. It depends on
the recipe builder (to build the recipe) and the backtest service (to run it), but has
its own error handling, status messaging, and Polymarket outcome attachment logic.
Isolating it makes the replay path independently modifiable.

---

#### 1e. `lib/strategy-ensemble-export.ts` (new)

**Purpose:** Bridge script download, env copy, file utilities.

**Methods to move in:**
- `downloadSelectedSignalRecipeBridge()`
- `copySelectedSignalRecipeEnv()`
- `deleteSelectedSignalRecipe()`
- `downloadTextFile()`
- `copyToClipboard()`

**Why:** Export is a self-contained feature with no dependency on ensemble evaluation
or UI rendering. It only needs access to the selected recipe and direction override.
These five methods can live entirely outside the service class.

---

#### 1f. Keep in `strategy-ensemble-service.ts` (slimmed)

**Purpose:** Thin facade — initialization, event binding, DOM rendering, delegation.

**Methods remaining:**
- `init()`
- `getDom()`
- `bindEvents()` — rewired to delegate to extracted modules
- `syncReadouts()`
- `syncSavedSignalRecipeOptions()`
- `syncSavedSignalRecipeControls()`
- `updateSignalRecipeStatus()`
- `updateStatus()` / `updatePolymarketStatus()`
- `syncPolymarketAvailability()`
- `populateConfigs()`
- All target picker UI methods
- All context selection UI methods
- All label/description helpers

**Estimated size after split:** ~600–700 lines (UI binding + rendering + delegation).

---

#### State Sharing Between Extracted Modules

| Field | Owner After Split | Accessors |
|-------|------------------|-----------|
| `runContext` | ensemble-engine module | Service reads for preview; engine writes |
| `lastPolymarketRunResult` | polymarket-runner module | Recipe builder reads; polymarket runner writes |
| `lastPolymarketSelection` | polymarket-runner module | Recipe builder reads |
| `lastPolymarketOutcomes` | polymarket-runner module | Recipe runner reads |
| `dom` | Service (original) | Only the service renders |
| `initialized` | Service (original) | Only the service checks initialization guard |
| `contextCheckboxes`, `contextItems`, `contextConfigs`, `contextOrder`, `targetOptionButtons`, `lastContextToggleName`, `targetMenuOpen` | Service (original) | Pure UI state, never leaves the service |
| `MAX_REPLACEMENT_ROWS`, `MAX_RULE_VALIDATION_CANDIDATES`, `MAX_RULE_BUILDER_ROWS` | Service (original, static readonly) | Referenced by methods in facade; stay as class constants |

**Mechanism:** Extracted modules expose their fields through getter/setter methods or
accept them as parameters. The service passes references during initialization. No
module directly accesses another module's internal state.

---

## File 2: `lib/data-manager.ts`

### Current State

| Metric | Value |
|--------|-------|
| Lines | 1,769 |
| Methods | 64 (22 public, 42 private) |
| Private fields | 26 + 4 public fields (`isStreaming`, `streamSymbol`, `streamInterval`, `streamProvider`) |
| Imports | 66 from 20 modules |
| Exported singleton | `dataManager` |

### Identified Responsibility Domains

| Domain | Method Count | Purpose |
|--------|-------------|---------|
| Provider routing | 5 | Resolve which provider handles a symbol |
| Public fetch entry points | 8 | High-level fetch, setSymbol, loadData |
| Provider chain resolution & dispatch | 8 | Build fallback chain, dispatch to provider |
| Binance hybrid fetch | 2 | Full Binance load path (SQLite → cache → seed → network → merge) |
| In-memory LRU caching | 5 | Cache key building, read, write, evict |
| Persistence (SQLite + IndexedDB) | 4 | Load/persist candles to storage |
| WebSocket streaming | 6 | Connect, update, close, reconnect |
| Polling | 5 | Poll-based streaming for non-WS providers |
| Gap detection & backfill | 1 | Detect and fill gaps in realtime data |
| Realtime candle application | 1 | Validate and apply incoming candles to state |
| Sanitization | 2 | Validate Binance candle integrity |
| Data normalization | 8 | Resample, interval resolution, Bybit seed merge |
| Misc / configuration | 8 | Imported data, lookback bars, suppress reload |

### Proposed Module Split

#### 2a. `lib/data/data-provider-router.ts` (new)

**Purpose:** Map symbol → provider, handle overrides.

**Methods to move in:**
- `getDefaultBinanceProvider()`
- `getStorageSymbol()`
- `getProvider()`
- `setProviderOverride()`
- `getProviderStorageLabel()`

**Fields to move in:**
- `providerOverrideBySymbol`

**Why:** Provider resolution is a pure mapping concern with no side effects. It is
called from nearly every other method in DataManager, making it a foundational module
that others should import rather than call back into the god object. Extracting it
breaks the circular dependency where fetch methods call provider routing and provider
routing lives in the same class as WebSocket management.

---

#### 2b. `lib/data/data-cache.ts` (new)

**Purpose:** In-memory LRU candle cache with cache key construction.

**Methods to move in:**
- `buildCacheKey()`
- `invalidateCacheEntry()`
- `updateCacheEntryFor()`
- `getCachedCandles()`
- `setCachedCandles()`

**Fields to move in:**
- `MAX_CACHE_ENTRIES`
- `lruCache`
- `cacheSyncAtByKey`

**Why:** The LRU cache is self-contained data structure logic. It has no dependency on
fetching, streaming, or providers — it only needs the storage symbol and interval to
build keys. Extracting it makes the cache replaceable (e.g., for testing with a mock
cache or tuning eviction policy independently).

---

#### 2c. `lib/data/data-persistence.ts` (new)

**Purpose:** Write candles to SQLite and IndexedDB; load from local sources.

**Methods to move in:**
- `loadNonBinanceLocalData()`
- `persistNonBinanceData()`
- `persistLocalCandles()`
- `queuePersistCandles()`
- `normalizeExternalCandles()`

**Fields to move in:**
- `cachePersistTimers`
- `cachePersistPendingByKey`

**Depends on:** data-cache (for setCachedCandles), data-provider-router (for storage
symbol/interval), external candle-cache and local-sqlite-api modules.

**Why:** Persistence is a cross-cutting concern that currently interleaves with fetch
logic. The debounced `queuePersistCandles()` has its own timer and pending-payload
state that is independent of WebSocket or gap-fill logic. Separating it makes the
persist path independently testable with SQLite/IndexedDB mocks.

---

#### 2d. `lib/data/data-stream.ts` (new)

**Purpose:** WebSocket connection, polling, reconnection, and realtime candle flow.

**Methods to move in:**
- `startStreaming()`
- `stopStreaming()`
- `isActiveStreamContext()`
- `connectBinanceStream()`
- `handleStreamUpdate()`
- `handleStreamClose()`
- `attemptReconnect()`
- `startPolling()`
- `scheduleNextPoll()`
- `getPollingDelayMs()`
- `pollLatest()`
- `shouldUseBinanceAlignedPolling()`
- `backfillRealtimeGap()`
- `applyRealtimeCandle()`

**Fields to move in:**
- `ws`, `isStreaming`, `streamSymbol`, `streamInterval`, `streamProvider`, `streamSessionId`
- `isPolling`, `pollTimeout`, `pollingInFlight`, `pollAbort`
- `reconnectAttempts`, `reconnectTimeout`, `RECONNECT_DELAY_BASE`
- `lastLogTime`, `lastUiUpdateTime`
- `realtimeGapFillInFlight`

**Depends on:** data-provider-router (for provider resolution), data-persistence (for
queuePersistCandles), data-cache (for cache key), state (for ohlcvData updates).

**Why:** Streaming is the most stateful domain in DataManager — it owns 16 of the 26
private fields. It has a clear lifecycle (start → update → reconnect → stop) that is
entirely independent of how historical data is fetched. Extracting it produces a
self-contained module with a single responsibility: keep the chart data fresh.

---

#### 2e. `lib/data/data-fetcher.ts` (new)

**Purpose:** Historical data fetching — the full fetch chain for each provider.

**Methods to move in:**
- `fetchData()`
- `fetchDataDetached()`
- `fetchDataForScan()`
- `fetchDataForScanWithMeta()`
- `fetchDataWithLimit()`
- `fetchHistoricalData()`
- `resolveProviderFallbackChain()`
- `fetchDataFromProviderChain()`
- `fetchMockChartData()`
- `fetchBinanceChartData()`
- `fetchBybitTradFiChartData()`
- `fetchPolymarketChartData()`
- `fetchLimitedNonBinanceNetworkData()`
- `fetchNonBinanceData()`
- `fetchBinanceDataHybridWithMeta()`
- `fetchBinanceDataHybridInternal()`
- `sanitizeBinanceCandles()`
- `isIntervalAlignedTime()`
- `mergeBybitRecentIntoSeed()`
- `getBybitSeedOverlayBars()`

**Depends on:** data-provider-router, data-cache, data-persistence.

**Why:** The fetch path is the largest domain by method count (20 methods). It has a
clear entry point (`fetchData`) and a clear output (candles array). It does not own
streaming state or imported data state. Extracting it separates "how do we get
historical data" from "how do we keep it fresh" and "how do we persist it."

---

#### 2f. Keep in `data-manager.ts` (slimmed)

**Purpose:** Thin facade — symbol switching, configuration, imported data management.

**Methods remaining:**
- `setSymbol()` — delegates to data-fetcher (fetch) + data-stream (start/stop)
- `loadData()`
- `isMockSymbol()`
- `suppressNextAutoReload()` / `shouldSkipAutoReload()`
- `setChartLookbackBars()` / `getChartLookbackBars()`
- `registerImportedData()` / `clearImportedData()`
- `getLoadedContextKey()`
- `describeLocalSource()`
- `getResampleOptions()`
- `getStorageInterval()`
- `takeLastCandles()`
- `notifyDataFallback()`

**Fields remaining:**
- `autoReloadSuppressCount`
- `importedDataByKey`
- `chartLookbackBars`
- `loadedSymbol`, `loadedInterval`, `loadedBinanceMarketType`
- `reporter`

**Estimated size after split:** ~200–300 lines (delegation + configuration).

---

#### State Sharing Between Extracted Modules

| Field | Owner After Split | Accessors |
|-------|------------------|-----------|
| `providerOverrideBySymbol` | data-provider-router | Fetcher reads, Stream writes (on non-Binance pin) |
| `lruCache`, `cacheSyncAtByKey` | data-cache | Fetcher reads/writes, Persistence writes |
| `cachePersistTimers`, `cachePersistPendingByKey` | data-persistence | Only persistence module accesses |
| `ws`, `isStreaming`, `streamSymbol`, `streamInterval`, `streamProvider`, etc. | data-stream | Only stream module accesses |
| `isStreaming`, `streamSymbol`, `streamInterval`, `streamProvider` (public fields) | data-stream | **External consumers read these.** Stream module exposes public getters; facade forwards them for backward compatibility. |
| `importedDataByKey` | data-manager (facade) | Fetcher reads via getter |
| `chartLookbackBars` | data-manager (facade) | Fetcher reads via getter |
| `reporter` | data-manager (facade) | Fetcher reads via getter |

**Mechanism:** The facade holds references to all extracted modules. Fetch and stream
receive the router, cache, and persistence modules as constructor arguments. No module
imports the facade — dependency direction is one-way outward.

---

## File 3: `lib/polymarket-panel-service.ts`

### Current State

| Metric | Value |
|--------|-------|
| Lines | 1,400 |
| Methods | 51 (1 public, 50 private) |
| Private fields | 17 |
| Imports | 42 from 22 modules |
| Exported singleton | `polymarketPanelService` |

### Identified Responsibility Domains

| Domain | Method Count | Purpose |
|--------|-------------|---------|
| Lifecycle / init | 3 | init, bindEvents, bindState |
| Data loading / outcomes | 5 | Fetch outcome rows from SQLite, annotate trades |
| Settings / DOM readers | 8 | Read entry offset, exit mode, execution model, scope |
| Rendering / diagnostics | 9 | Summary cards, payout section, diagnostic buckets |
| Deployability analysis | 4 | Render deployability panel with verdict, confidence, blocks |
| Bridge export | 10 | Build/download PowerShell script, copy env, config dropdown |
| Formatting helpers | 7 | Format percent, probability, cents, USD |
| Utility / infrastructure | 5 | Panel visibility, result signature, download/clipboard, getDom |

### Proposed Module Split

#### 3a. `lib/polymarket-outcome-loader.ts` (new)

**Purpose:** Load Polymarket outcome rows from SQLite and annotate backtest trades.

**Methods to move in:**
- `handleBacktestResultChange()`
- `ensureOutcomeRowsForCurrentResult()`
- `attachLoadedPolymarketOutcomes()`
- `enrichHistoryInBackground()`
- `resetLoadedRows()`

**Fields to move in:**
- `loadedOutcomeRows`
- `outcomeByStartTs`
- `historySummaryByStartTs`
- `lastResult`
- `isLoading`
- `isEnrichingHistory`
- `loadError`
- `loadNonce`
- `loadedResultSignature`

**Why:** Outcome loading is a complex async pipeline with nonce-based stale-request
cancellation, background enrichment workers, and dual-mode annotation (signal-exit vs
resolve-hold). It owns 9 of the 17 private fields. It is the largest and most complex
domain in the file. Extracting it makes the loading pipeline independently testable
and decouples it from rendering and export.

---

#### 3b. `lib/polymarket-panel-renderer.ts` (new)

**Purpose:** All HTML generation for the Polymarket diagnostics panel.

**Methods to move in:**
- `render()`
- `renderPolymarketDiagnostics()`
- `getPolymarketSummary()`
- `buildPayoutSummarySection()`
- `buildPolymarketSummarySection()`
- `buildDiagnosticBucketSection()`
- `renderStatCard()`
- `renderDeployabilityAnalysis()`
- `getEvaluatedOutcomeRows()`
- `getDeployabilityAnalysis()`
- `getVerdictDescription()`
- `showEmpty()`
- `scheduleRender()`
- `getResultSignature()`

**Fields to move in:**
- `deployabilityCacheKey`
- `deployabilityCache`
- `renderFrameId`
- `renderTimeoutId`

**Why:** Rendering is the second-largest domain and is presentation-only. It does not
fetch data or manage state — it reads from the outcome loader's results and produces
HTML. Extracting it follows the existing renderer convention in the codebase (cf.
`strategy-ensemble-renderer.ts`, `resultsRenderer.ts`).

---

#### 3c. `lib/polymarket-bridge-export.ts` (new)

**Purpose:** PowerShell bridge script generation, download, and env snippet copy.

**Methods to move in:**
- `renderBridgeControls()`
- `ensureBridgeConfigOptions()`
- `getSelectedBridgeConfig()`
- `handleBridgeScriptDownload()`
- `handleCopyBotEnv()`
- `getBridgeExportContext()`
- `buildBridgeScript()`
- `buildBotEnvSnippet()`
- `resolveExternalSignalSymbol()`
- `slugifyConfigName()`
- `toPowerShellSingleQuoted()`
- `downloadTextFile()`
- `copyToClipboard()`

**Fields to move in:**
- `bridgeConfigSignature`
- `selectedBridgeConfigName`

**Why:** Bridge export is a fully self-contained feature. `buildBridgeScript()` alone is
215 lines of PowerShell string generation. It has no dependency on outcome loading or
diagnostics rendering — it only needs the current strategy config and backtest result.
Extracting it removes the single largest method from the service class and isolates a
feature that can be developed, tested, and potentially removed independently.

---

#### 3d. `lib/polymarket-formatting.ts` (new)

**Purpose:** Pure formatting functions for Polymarket-specific display values.

**Methods to move in:**
- `formatScopeLabel()`
- `formatPercent()`
- `formatProbability()`
- `formatPolymarketCents()`
- `formatProfitFactor()`
- `formatSignedUsd()`

**Why:** These are pure functions with no state dependency. They are used by the
renderer and could be reused by other Polymarket surfaces (Quick View, Finder). Making
them a shared utility eliminates duplication risk.

---

#### 3e. Keep in `polymarket-panel-service.ts` (slimmed)

**Purpose:** Thin facade — initialization, event/state binding, delegation.

**Methods remaining:**
- `init()`
- `bindEvents()` — rewired to delegate to bridge-export and renderer
- `bindState()` — rewired to delegate to outcome-loader
- `isPanelVisible()`
- `getDom()`
- `resolveSelectedPolymarketEntryOffset()`
- `readCurrentPolymarketEntryOffset()`
- `readCurrentPolymarketExitMode()`
- `readCurrentExecutionModel()`
- `readCurrentPolymarketOutcomeSymbol()`
- `resolveActivePolymarketOutcomeSymbol()`
- `readEntryPriceCents()`
- `readScope()`

**Estimated size after split:** ~200–300 lines (init + DOM readers + delegation).

---

#### State Sharing Between Extracted Modules

| Field | Owner After Split | Accessors |
|-------|------------------|-----------|
| `loadedOutcomeRows`, `outcomeByStartTs`, `historySummaryByStartTs` | outcome-loader | Renderer reads via getter |
| `lastResult` | outcome-loader | Bridge export reads via getter |
| `deployabilityCache*` | renderer | Self-contained |
| `bridgeConfigSignature`, `selectedBridgeConfigName` | bridge-export | Self-contained |
| `dom` | service (facade) | Only facade and renderer reference |
| `initialized`, `loadNonce` | outcome-loader | Service checks initialized guard |

**Mechanism:** The facade holds the outcome-loader and renderer instances. Renderer
receives outcome-loader as a dependency (for reading loaded rows). Bridge-export
receives only the DOM contract and settings-manager. No circular references.

---

## File 4: `lib/backtest-service.ts`

### Current State

| Metric | Value |
|--------|-------|
| Lines | 1,089 |
| Methods | 36 (14 public, 22 private) |
| Private fields | 3 |
| Imports | 80 from 38 modules |
| Exported singleton | `backtestService` |

### Identified Responsibility Domains

| Domain | Method Count | Purpose |
|--------|-------------|---------|
| Interactive run orchestration | 4 | runCurrentBacktest, runCombinedStrategyBacktest, preview, subscription |
| Core execution delegation | 4 | Bridge to TS/Rust engine layer |
| Rust engine eligibility | 3 | Decide TS vs Rust, validate consistency |
| Settings reading (DOM → typed) | 4 | Read capital/backtest settings from DOM inputs |
| Result post-processing | 3 | Finalize, recompute Sharpe, recompute analytics |
| Polymarket annotation | 1 | Attach Polymarket outcomes to backtest result |
| Data selection & filtering | 2 | Closed candle selection, block range filtering |
| Endpoint copy / preview | 8 | Build/copy/preview backtest endpoint requests |
| External evaluation API | 2 | evaluateStrategyOnData, evaluateSignalsOnData |
| Chart indicator rendering | 2 | Add strategy indicators to chart |
| Stale-run sequencing | 3 | Interactive run ID tracking |

### Proposed Module Split

#### 4a. `lib/backtest-settings-reader.ts` (new)

**Purpose:** Read backtest and capital settings from DOM inputs → typed objects.

**Methods to move in:**
- `getCapitalSettings()`
- `getBacktestSettings()`
- `readDomSettingValue()`
- `resolveSubscriptionCapitalSettings()`

**Why:** Reading settings from the DOM is the most testability-blocking concern in the
current service. Every backtest execution path starts by reading 10+ DOM inputs.
Extracting this into a standalone module makes it mockable — callers pass in a typed
settings object instead of letting the service query the DOM. This is the single
highest-value extraction for enabling headless testing.

**No fields move** — this module is stateless. It reads DOM and returns typed objects.

---

#### 4b. `lib/backtest-endpoint-facade.ts` (new)

**Purpose:** Endpoint copy/preview — the backtest-endpoint feature's service layer.

**Methods to move in:**
- `canCopyLatestUiBacktestEndpointRequest()`
- `canRunLatestUiBacktestEndpointPreview()`
- `runLatestUiBacktestEndpointPreview()`
- `buildLatestUiBacktestEndpointCopyBundle()`
- `createEndpointCopySnapshot()`
- `canUseCurrentChartForEndpointCopy()`
- `compactMetricResultsMatch()`
- `resolveEndpointCrossSymbolDataset()`

**Why:** Endpoint copy/preview is a complete feature with 8 methods and heavy imports
from `backtest-endpoint-copy.ts`, `backtest-endpoint-execution.ts`, and
`backtest-endpoint-contract.ts`. It is tangential to backtest execution — it operates
on snapshots of past runs. Extracting it removes a large feature cross-section from
the service and groups all endpoint-related logic together.

**No fields move** — this module uses only the `interactiveRunSequence` from the parent
for staleness checks, which can be passed as a parameter.

---

#### 4c. `lib/backtest-chart-renderer.ts` (new)

**Purpose:** Add strategy indicators to the chart after backtest execution.

**Methods to move in:**
- `addStrategyIndicators()`
- `addIndicatorToChart()`

**Why:** Chart indicator rendering is a side effect of backtest completion that belongs
with chart management, not backtest orchestration. Extracting it follows the existing
pattern where chart-manager handles series lifecycle.

---

#### 4d. Keep in `backtest-service.ts` (slimmed)

**Purpose:** Backtest execution orchestration — the core run paths.

**Methods remaining:**
- `runCurrentBacktest()`
- `previewCurrentBacktestWithSettings()`
- `runCombinedStrategyBacktest()`
- `executeBacktest()`
- `runBacktestForData()`
- `runBacktestForPreparedSignals()`
- `runBacktestForPreparedData()`
- `runBacktestForSubscription()`
- `evaluateStrategyOnData()`
- `evaluateSignalsOnData()`
- `annotatePolymarketResult()`
- `selectClosedCandleData()`
- `filterSignalsByBlockRange()`
- `finalizeBacktestResult()`
- `recomputeSharpeRatio()`
- `recomputePerformanceAnalytics()`
- `requiresTypescriptEngine()`
- `requiresTypescriptSizingMode()`
- `isResultConsistent()`
- `shouldCaptureTimingBreakdown()`
- `beginInteractiveRun()`
- `isLatestInteractiveRun()`

**Fields remaining:**
- `warnedStrictEngine`
- `timingBreakdownSampleCount`
- `interactiveRunSequence`

**Estimated size after split:** ~500–600 lines (execution orchestration only).

---

#### State Sharing Between Extracted Modules

| Field | Owner After Split | Accessors |
|-------|------------------|-----------|
| `interactiveRunSequence` | backtest-service | Endpoint facade reads via getter for staleness check |
| `warnedStrictEngine` | backtest-service | Only orchestration uses |
| `timingBreakdownSampleCount` | backtest-service | Only orchestration uses |

**Mechanism:** Backtest-service holds the settings-reader and endpoint-facade as
delegated modules. Public methods like `getCapitalSettings()` become thin wrappers
that delegate to the settings-reader. The endpoint methods delegate entirely.

---

## Execution Order

The splits are independent per file, but within each file the recommended order is:

### strategy-ensemble-service.ts
1. **Export** (1e) — smallest, zero shared state, instant win
2. **Recipe builder** (1c) — pure logic, no DOM, easy to validate
3. **Polymarket runner** (1b) — isolates Polymarket state lifecycle
4. **Recipe runner** (1d) — depends on recipe builder, straightforward delegation
5. **Ensemble engine** (1a) — touches the core `run()`, highest risk, do last

### data-manager.ts
1. **Provider router** (2a) — foundational, others depend on it
2. **Cache** (2b) — self-contained data structure
3. **Persistence** (2c) — depends on router + cache
4. **Streamer** (2d) — depends on router + cache + persistence
5. **Fetcher** (2e) — depends on router + cache + persistence, largest extraction

### polymarket-panel-service.ts
1. **Formatting** (3d) — pure functions, zero risk
2. **Bridge export** (3c) — self-contained, removes largest method
3. **Outcome loader** (3a) — isolates async loading + 9 fields
4. **Renderer** (3b) — depends on outcome loader

### backtest-service.ts
1. **Settings reader** (4a) — highest testability impact
2. **Chart renderer** (4c) — smallest extraction, clear boundary
3. **Endpoint facade** (4b) — removes 8 methods

### Cross-file priority (recommended sequence across files)

| Phase | File | Module | Risk | Impact |
|-------|------|--------|------|--------|
| 1 | ensemble | Export (1e) | Low | Removes 5 methods |
| 2 | polymarket | Formatting (3d) | Low | Removes 6 pure functions |
| 3 | backtest | Settings reader (4a) | Low | Enables headless testing |
| 4 | data | Provider router (2a) | Low | Foundational for data splits |
| 5 | backtest | Chart renderer (4c) | Low | Small, clear boundary |
| 6 | polymarket | Bridge export (3c) | Medium | Removes 215-line method |
| 7 | ensemble | Recipe builder (1c) | Medium | 12 methods, pure logic |
| 8 | data | Cache (2b) | Low | Self-contained |
| 9 | backtest | Endpoint facade (4b) | Medium | 8 methods, heavy imports |
| 10 | data | Persistence (2c) | Medium | Timer state, async paths |
| 11 | polymarket | Outcome loader (3a) | Medium-High | 9 fields, async nonce logic |
| 12 | data | Streamer (2d) | Medium-High | 16 fields, WS lifecycle |
| 13 | ensemble | Polymarket runner (1b) | Medium | Own run lifecycle |
| 14 | ensemble | Recipe runner (1d) | Medium | Depends on builder |
| 15 | polymarket | Renderer (3b) | Medium | Depends on loader |
| 16 | data | Fetcher (2e) | High | Largest extraction, many paths |
| 17 | ensemble | Ensemble engine (1a) | High | Core `run()`, do last |

---

## Validation Strategy

After each module extraction:

1. **TypeScript compilation:** `npm run typecheck` must pass.
2. **Existing tests:** `npm run test` must pass. No new tests needed for behavior-preserving
   extraction, but the existing test suite must remain green.
3. **DOM contracts:** Run `feature-dom-contracts.spec.ts` for any file that touches DOM.
4. **Manual smoke test:** Load the UI, trigger the affected feature, verify the same
   behavior as before. For backtest-service, run a backtest. For data-manager, switch
   symbols and verify streaming. For ensemble, run an ensemble evaluation. For
   polymarket, load a polymarket backtest and check diagnostics.
5. **Import audit:** Verify no extracted module imports the original singleton (no
   circular dependency).

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking the singleton's public API | Original singleton keeps all public methods as delegation wrappers. No consumer changes. |
| Introducing circular imports between extracted modules | Each module only imports from lower-level utilities, never from sibling modules or the facade. Enforced by import audit after each extraction. |
| Losing shared mutable state semantics | Fields that are read by multiple domains move to the lowest common owner and are accessed via explicit getters/setters rather than implicit `this.field` access. |
| Regressions in streaming (data-manager) | Stream module extraction is done last within data-manager, after fetch and persistence are validated. Stream has the most async state and benefits from prior extraction experience. |
| Polymarket annotation drift | The outcome loader extraction preserves the nonce-based stale-request guard. No behavior change in the async loading pipeline. |

---

## Expected Outcomes After Full Execution

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| `strategy-ensemble-service.ts` | ~2,172 lines, 87 methods | ~700–800 lines, ~30 methods | ~65% |
| `data-manager.ts` | ~1,769 lines, 64 methods | ~200–300 lines, ~14 methods | ~85% |
| `polymarket-panel-service.ts` | ~1,400 lines, 51 methods | ~200–300 lines, ~13 methods | ~80% |
| `backtest-service.ts` | ~1,089 lines, 36 methods | ~500–600 lines, ~22 methods | ~45% |

All four files drop below 800 lines. No file in the codebase exceeds 800 lines after
this plan is complete (excluding auto-generated files and the strategy manifest).

---

## Audit Log (2026-04-13)

Verified all metric claims, method names, field inventories, and cross-file dependencies
against source. Applied corrections inline. Findings:

1. **strategy-ensemble-service.ts line count was understated by 235 lines** (1,937 → 2,172).
   Updated the expected-outcome table accordingly.

2. **data-manager.ts public/private split was wrong by 11 methods** (claimed 33/31, actual
   22/42). Total was correct. 4 public fields (`isStreaming`, `streamSymbol`,
   `streamInterval`, `streamProvider`) were missing from the state-sharing table — added
   with guidance that stream module exposes getters and facade forwards them.

3. **backtest-service.ts public/private split was off by 2** (claimed 12/24, actual 14/22).

4. **polymarket-panel-service.ts imports from 22 modules, not 18** — coupling surface is
   larger than anticipated.

5. **strategy-ensemble-service.ts field count was ambiguous.** Actual: 13 instance + 3
   static readonly. The `initialized` field and 3 static constants (`MAX_REPLACEMENT_ROWS`,
   `MAX_RULE_VALIDATION_CANDIDATES`, `MAX_RULE_BUILDER_ROWS`) were missing from the
   state-sharing table — added.

6. **`buildRulesRuntime()` has hidden coupling** to `this.yieldToUi()` and
   `this.updateStatus()` — added injection note to section 1a.

7. **All method names verified.** No phantom or renamed methods found across all four files.

8. **No circular imports** between the four god objects. Dependency chain is one-directional:
   `strategy-ensemble-service → backtest-service → data-manager`. `polymarket-panel-service`
   is independent.
