/**
 * Batch Backtest UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/hunt/hunt-service.ts`). Binds the tab's buttons, reads the CURRENT
 * strategy / params / backtest / capital settings once per run, and replays
 * them across every pair in the user's list through the pure runner.
 *
 * Visual output mirrors Finder's universe symbol rows (same verdict labels
 * and metric order) so a Batch run reads the same as a Finder universe run.
 */

import { ensureBuiltInStrategyLoaded } from "../strategies/built-in-catalog";
import { backtestService } from "../backtest-service";
import { shouldUseRustEngine } from "../engine-preferences";
import { paramManager } from "../param-manager";
import { state } from "../state";
import { strategyRegistry } from "../../strategyRegistry";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";
import { copyToClipboard } from "../browser-transfer";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import { clearBatchDatasetCaches, getBatchDatasetCacheStats, loadBatchDataset } from "./batch-backtest-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { mapWithConcurrencyLimit } from "../async-pool";
import { parseIntervalSeconds } from "../interval-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    runBatchBacktest,
    type BatchBacktestSymbolResult,
} from "./batch-backtest-runner";
import { buildBatchRunFingerprint, parseBatchSymbols } from "./batch-run-contract";
import {
    formatBatchOverallSummary,
    formatBatchSummaryLine,
    formatResultRowPipe,
} from "./batch-backtest-summary";
import {
    compactBatchBacktestResultsSnapshot,
    normalizeBatchBacktestResultsSnapshot,
    type BatchBacktestResultsSnapshot,
} from "./batch-backtest-snapshot";
import {
    BATCH_BENCHMARK_SCHEMA,
    benchmarkRatio,
    buildBatchBenchmarkBottlenecks,
    buildCacheStatsFromLoader,
    type BatchBenchmarkCacheSource,
    type BatchBenchmarkCacheStats,
    type BatchBenchmarkMinePhase,
    type BatchBenchmarkRunPhase,
    type BatchBenchmarkSnapshot,
    type BatchBenchmarkStabilityPhase,
} from "./batch-benchmark-snapshot";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import type { BatchStreamEvent, BatchMinerStreamEvent, BatchStabilityMineStreamEvent } from "./batch-backtest-stream-types";
import {
    createBatchSyntheticMinerProfile,
    prepareBatchSyntheticPairArtifacts,
    prepareBatchSyntheticTargetArtifacts,
    resolveBatchSyntheticTargetSymbol,
    runPreparedBatchSyntheticStateMiner,
    runBatchSyntheticStateMiner,
    BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
    type BatchSyntheticAssetVerdict,
    type BatchSyntheticMinerResult,
    type BatchSyntheticPairContribution,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import {
    addStabilityVerdicts,
    createStabilityAggregate,
    finalizeStabilityAggregate,
    sampleItems,
    type BatchStabilityMineResult,
    type BatchStabilityRow,
} from "./batch-stability-mine";
import {
    projectMineVerdictToSnapshot,
    projectStabilityRowToSnapshot,
    type TimingEdgePersistedRun,
} from "./mine-timing-persistence";
import { storeMineTimingRun } from "../local-sqlite-mine-timing-api";
import {
    computeMinerAgeTag,
    computeMinerTargetPrice,
    computeStabilityAction,
    computeStabilityAgeTag,
    computeStabilityDataLagBars,
    computeStabilityGate,
    formatTargetPrice,
    STABILITY_DATA_STALE_THRESHOLD_BARS,
    summarizeStabilityDataFreshness,
} from "./miner-verdict-format-helpers";
import type { Strategy, StrategyParams, BacktestSettings } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";

const BATCH_RESULTS_STORAGE = {
    key: "playground_batch_backtest_latest_results",
    schema: "batch_backtest.latest_results",
    version: 1,
} as const;

class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: BatchBacktestSymbolResult[] = [];
    private lastMinerResult: BatchSyntheticMinerResult | null = null;
    private lastStabilityResult: BatchStabilityMineResult | null = null;
    private lastRunFingerprint: string | null = null;
    private lastRunInterval: string | null = null;
    // The strategy key that governed the last Run, captured at run start so
    // server-side Mine persists the strategy that actually ran — not whatever
    // is selected in `state` at Mine-click time. Without this, switching
    // strategy between Run and Mine would write the wrong strategyKey.
    private lastRunStrategyKey: string | null = null;
    // Number of result rows already appended to the DOM via onSymbolComplete.
    // Tracked so the post-run path only appends the cancelled back-fill tail
    // instead of rebuilding every row (the runner emits onSymbolComplete in
    // strict input order, so the incremental appends are already ordered).
    private appendedCount = 0;
    // Monotonic run token. A stale run that resumes after a newer run started
    // (e.g. Stop -> Run while the old run is still awaiting executeBacktest)
    // sees its token as stale and stops writing DOM/state, preventing two
    // concurrent runs from racing on `this.lastResults` and the results list.
    private runToken = 0;
    // True when the most recent server-side Run finished with artifacts still
    // on the server (the Mine Timing button is enabled on this flag, NOT on
    // `row.data !== undefined`, because in server-side mode the browser never
    // holds `row.data`).
    private serverHasArtifacts = false;
    // Reattach polling timer id (set when this tab is observing a server-side
    // run that started before page load).
    private reattachTimer: ReturnType<typeof setTimeout> | null = null;
    private reattachTimerResolve: (() => void) | null = null;
    private reattachPollingStopped = false;
    // Benchmark snapshot for the Copy Benchmark button. Each phase (run/mine/
    // stability) records wall clock + cache stats on completion; missing phases
    // stay null. `null` until at least one phase has completed in this session.
    private lastBenchmark: BatchBenchmarkSnapshot | null = null;
    private pendingServerRunCacheStats: BatchBenchmarkCacheStats | null = null;

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    public init(): void {
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.resetProgress(dom);
        this.loadPersistedLatestResults(dom);
        this.updateSummary(dom);
        this.initialized = true;
        // Reattach to a server-side run that started before page load. Mirrors
        // IBKR sync's `reattachToInProgressSync` poll on init. Polls every 2s
        // and renders the snapshot rows accumulated server-side so a tab reload
        // mid-run still shows the live progress (2s granularity, not per-symbol).
        void this.reattachToInProgressServerRun();
    }

    private bindEvents(dom: BatchBacktestDom): void {
        dom.batchBacktestRunBtn.addEventListener("click", () => {
            void this.runBatch();
        });
        dom.batchBacktestStopBtn.addEventListener("click", () => {
            this.cancelled = true;
            void this.stopServerRun();
        });
        dom.batchBacktestCopyBtn.addEventListener("click", () => {
            void this.copyResults();
        });
        dom.batchBacktestCopyBenchmarkBtn.addEventListener("click", () => {
            void this.copyBenchmarkPerformance();
        });
        dom.batchBacktestMineBtn.addEventListener("click", () => {
            void this.runMiner();
        });
        dom.batchBacktestCopyMinerBtn.addEventListener("click", () => {
            void this.copyMinerResults();
        });
        dom.batchBacktestStabilityMineBtn.addEventListener("click", () => {
            void this.runStabilityMine();
        });
        dom.batchBacktestCopyStabilityBtn.addEventListener("click", () => {
            void this.copyStabilityResults();
        });
        dom.batchBacktestUseCurrent.addEventListener("click", () => {
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value.trim();
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value
                    ? `${dom.batchBacktestSymbols.value}\n${current}`
                    : current;
            }
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.batchBacktestClear.addEventListener("click", () => {
            dom.batchBacktestSymbols.value = "";
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.batchBacktestSymbols.addEventListener("input", () => {
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
    }

    private async runBatch(): Promise<void> {
        const dom = this.getDom();
        const symbols = parseBatchSymbols(dom.batchBacktestSymbols.value);
        if (symbols.length === 0) {
            dom.batchBacktestStatus.textContent = "Add at least one pair.";
            return;
        }

        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            dom.batchBacktestStatus.textContent = `Strategy not loaded: ${strategyKey}`;
            return;
        }

        // Read the CURRENT settings once. This is the core contract: Batch
        // replays whatever the user has tuned in the UI right now.
        const strategyParams = paramManager.getValues(strategy);
        const backtestSettings = backtestService.getBacktestSettings();
        const capitalSettings = backtestService.getCapitalSettings();
        const interval = state.currentInterval;
        const runFingerprint = this.buildRunFingerprint(symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval);

        // Invalidate any in-flight run and claim this one. The stale run will
        // see its token mismatch after its next await and stop mutating state.
        this.runToken += 1;
        const token = this.runToken;
        this.cancelled = false;
        this.lastResults = [];
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.lastRunStrategyKey = null;
        this.appendedCount = 0;
        this.serverHasArtifacts = false;
        this.clearPersistedLatestResults();
        this.stopReattachPoll();
        dom.batchBacktestRunBtn.disabled = true;
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestCopyBtn.disabled = true;
        dom.batchBacktestCopyBenchmarkBtn.disabled = true;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        this.clearMinerResults(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        // Server-side mode runs the workload in the Vite dev server process so
        // the browser tab stays bounded for 1000+ pair runs. Browser-side is
        // the legacy in-tab path; retained as a fallback for environments with
        // no dev server (e.g. `vite preview`). See
        // `docs/batch-backtest-server-side.md` for the full contract.
        //
        // `batchExecutionMode` lives on `BacktestSettingsData` (persistence
        // type), not on the narrower `BacktestSettings` runtime type that
        // `backtestService.getBacktestSettings()` returns. Read the DOM select
        // directly — it's the source of truth the user just toggled.
        const useServerMode = this.readBatchExecutionMode() === "server";
        // Reset the prior run's server cache stats so they can't leak into the
        // next run's benchmark if the `done` event never arrives (cancel /
        // crash). `recordRunBenchmark` re-populates this from the `done` event
        // or the recovery/reattach path.
        this.pendingServerRunCacheStats = null;
        const runStartedAt = performance.now();
        try {
            if (useServerMode) {
                await this.runBatchServer(dom, token, symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint);
            } else {
                await this.runBatchBrowser(dom, token, symbols, strategyKey, strategy, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint);
            }
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.batchBacktestStatus.textContent = `Error: ${message}`;
            debugLogger.error("batch_backtest.run_failed", { error: message });
        } finally {
            // Only restore buttons if this run is still the active one.
            if (token === this.runToken) {
                dom.batchBacktestRunBtn.disabled = false;
                setVisible(dom.batchBacktestStopBtn, false);
                dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
                // In server-side mode the artifacts stay on the server; the
                // Mine button must be gated on the `serverHasArtifacts` flag
                // (set by the `done` event), not on `row.data !== undefined`
                // (the browser never holds `row.data` in this mode).
                dom.batchBacktestMineBtn.disabled = useServerMode
                    ? !this.serverHasArtifacts
                    : !this.hasMineableArtifacts();
                dom.batchBacktestStabilityMineBtn.disabled = useServerMode
                    ? !this.serverHasArtifacts
                    : !this.hasMineableArtifacts();
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
                this.recordRunBenchmark(useServerMode ? "server" : "browser", strategyKey, interval, runStartedAt);
                // The leg/pair LRU was a within-run dedup layer (e.g. ZEC
                // appearing in many pairs fetched once). The run is over, and
                // Mine Timing repopulates only the target-asset datasets it
                // needs. Drop the resolved OHLCV arrays now so they don't sit
                // in memory across Copy / new Run / tab work. If the user
                // clicks Mine next, loadMinerTargets will refetch on miss.
                clearBatchDatasetCaches();
            }
        }
    }

    private async runBatchBrowser(
        dom: BatchBacktestDom,
        token: number,
        symbols: string[],
        strategyKey: string,
        strategy: Strategy,
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        interval: string,
        runFingerprint: string,
    ): Promise<void> {
        const output = await runBatchBacktest(
            {
                interval,
                strategyKey,
                strategy,
                strategyParams,
                backtestSettings,
                capitalSettings,
                symbols,
                loadDataset: (sym, intv, signal) => loadBatchDataset(sym, intv, signal),
            },
            {
                setProgress: (percent, text) => {
                    if (token !== this.runToken) return;
                    this.setProgress(dom, percent, text);
                },
                setStatus: (text) => {
                    if (token !== this.runToken) return;
                    dom.batchBacktestStatus.textContent = text;
                },
                onSymbolComplete: (_index, result) => {
                    if (token !== this.runToken) return;
                    this.lastResults.push(result);
                    this.appendedCount += 1;
                    this.appendResultRow(dom, result);
                },
                isCancelled: () => token !== this.runToken || this.cancelled,
            },
        );
        // A newer run has taken over; leave all UI state to that run.
        if (token !== this.runToken) return;
        this.lastResults = output.results;
        this.lastRunFingerprint = runFingerprint;
        this.lastRunInterval = interval;
        this.lastRunStrategyKey = strategyKey;
        // The runner emits onSymbolComplete in strict input order, so every
        // processed row is already in the DOM. Only the cancelled back-fill
        // tail (slots never processed because Stop broke the loop) needs to
        // be appended here. Avoids a full O(N) rebuild + reflow per run.
        for (let i = this.appendedCount; i < output.results.length; i += 1) {
            this.appendResultRow(dom, output.results[i]);
        }
        this.appendedCount = output.results.length;
        setVisible(dom.batchBacktestEmpty, output.results.length === 0);
        dom.batchBacktestStatus.textContent = this.cancelled
            ? `Stopped (${output.results.length}/${symbols.length} pairs)`
            : `Done (${output.results.length} pairs, ${output.failedSymbols.length} failed)`;
        this.saveLatestResultsSnapshot();
    }

    /**
     * Server-side run path: POST to `/api/batch-backtest/run`, consume the
     * NDJSON stream, and populate `lastResults` with SCALARS ONLY (no `data`,
     * `signals`, or `result.trades`). The server retains the heavy arrays for
     * Mine Timing; the browser tab stays bounded regardless of pair count.
     *
     * Copy Results stays at browser parity because the server sends small
     * derived scalars for B&H and open-trade asset scores.
     */
    private async runBatchServer(
        dom: BatchBacktestDom,
        token: number,
        symbols: string[],
        strategyKey: string,
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        interval: string,
        runFingerprint: string,
    ): Promise<void> {
        const response = await fetch("/api/batch-backtest/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbols,
                interval,
                strategyKey,
                strategyParams,
                backtestSettings,
                capitalSettings,
                useRustEnginePreference: shouldUseRustEngine(),
            }),
        });
        if (!response.ok || !response.body) {
            const text = await response.text();
            let payload: { error?: string } = {};
            try { payload = JSON.parse(text); } catch { /* ignore */ }
            throw new Error(payload.error ?? `Server run failed (${response.status}).`);
        }

        let doneSummary: string | null = null;
        // `requireTerminal: true` converts a clean-EOF-before-done into a
        // thrown `StreamEndedBeforeTerminalError`. Without this, a truncated
        // stream resolved normally with `doneSummary === null` and the run was
        // finalized as "Done" at 100% with partial data (audit finding 1).
        let streamError: unknown = null;
        try {
            await consumeNdjsonStream<BatchStreamEvent>(response.body, {
                onStart: (event: Extract<BatchStreamEvent, { type: "start" }>) => {
                    if (token !== this.runToken) return;
                    dom.batchBacktestStatus.textContent = `Server: 0/${event.total}`;
                },
                onProgress: (event: Extract<BatchStreamEvent, { type: "progress" }>) => {
                    if (token !== this.runToken) return;
                    this.setProgress(dom, event.percent, event.text);
                    dom.batchBacktestStatus.textContent = event.status;
                },
                onSymbol: (event: Extract<BatchStreamEvent, { type: "symbol" }>) => {
                    if (token !== this.runToken) return;
                    this.lastResults.push(event.row);
                    this.appendedCount += 1;
                    this.appendResultRow(dom, event.row);
                },
                onSymbolFailed: (event: Extract<BatchStreamEvent, { type: "symbol_failed" }>) => {
                    if (token !== this.runToken) return;
                    debugLogger.warn("batch.server.symbol_failed", {
                        symbol: event.symbol, index: event.index, error: event.error,
                    });
                },
                onDone: (event: Extract<BatchStreamEvent, { type: "done" }>) => {
                    if (token !== this.runToken) return;
                    this.lastRunFingerprint = runFingerprint;
                    this.lastRunInterval = interval;
                    this.lastRunStrategyKey = strategyKey;
                    this.serverHasArtifacts = event.serverHasArtifacts === true;
                    this.pendingServerRunCacheStats = event.cacheStats
                        ? buildCacheStatsFromLoader(event.cacheStats)
                        : null;
                    doneSummary = event.summary;
                    setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
                    dom.batchBacktestStatus.textContent = doneSummary;
                },
                onFatal: (event: Extract<BatchStreamEvent, { type: "fatal" }>) => {
                    if (token !== this.runToken) return;
                    throw new Error(event.error);
                },
            }, { requireTerminal: true });
        } catch (error) {
            // Defer to after the token check. A stale run that lost ownership
            // mid-stream must not mutate UI state.
            streamError = error;
        }
        if (token !== this.runToken) return;
        if (doneSummary === null) {
            // No terminal `done` arrived — either the stream threw mid-flight
            // OR it resolved cleanly before `done` (truncated response). Both
            // must attempt recovery against `/status` before presenting success;
            // if the server actually completed we adopt its authoritative rows.
            const recovered = await this.recoverCompletedServerRun(dom, runFingerprint, interval);
            if (recovered === null) {
                // Recovery did not match / found an still-running server: surface
                // the original stream error (or a synthesized one for clean EOF).
                const message = streamError instanceof Error
                    ? streamError.message
                    : (streamError ? String(streamError) : "Server stream ended before completion.");
                throw new Error(message);
            }
            doneSummary = recovered;
        } else if (streamError !== null) {
            // Terminal `done` was processed before the stream later errored —
            // the run is complete; the trailing error is informational only.
            debugLogger.warn("batch.server.stream_closed_after_done", {
                error: streamError instanceof Error ? streamError.message : String(streamError),
            });
        }
        if (token !== this.runToken) return;
        if (doneSummary !== null) {
            dom.batchBacktestStatus.textContent = doneSummary;
            this.saveLatestResultsSnapshot();
        }
    }

    private async recoverCompletedServerRun(
        dom: BatchBacktestDom,
        runFingerprint: string,
        interval: string,
    ): Promise<string | null> {
        try {
            // Draining recovered rows may take several paged requests. Bound
            // the page size and the absolute row count we'll pull so a
            // misbehaving server cannot make the browser loop forever.
            const PAGE_LIMIT = 250;
            const MAX_ROWS_TO_RECONSTRUCT = 10_000;
            const firstResponse = await fetch("/api/batch-backtest/status", { cache: "no-store" });
            if (!firstResponse.ok) return null;
            const firstPayload = await firstResponse.json() as {
                running?: boolean;
                lastRun?: {
                    rowCount?: number;
                    hasArtifacts?: boolean;
                    fingerprint?: string | null;
                    interval?: string | null;
                    strategyKey?: string | null;
                    cacheStats?: BatchDatasetCacheStats | null;
                    rows?: BatchBacktestSymbolResult[];
                    rowOffset?: number;
                    nextOffset?: number | null;
                } | null;
            };
            const lastRun = firstPayload.lastRun;
            if (firstPayload.running || !lastRun || lastRun.fingerprint !== runFingerprint) {
                return null;
            }
            this.lastRunFingerprint = runFingerprint;
            this.lastRunInterval = lastRun.interval ?? interval;
            // Adopt the strategy that actually governed the run so Mine
            // provenance survives a mid-stream disconnect (audit finding 5).
            // The server returns `lastRun.strategyKey`; only fall back to the
            // caller-supplied interval (already handled above) — never to the
            // mutable current-UI strategy, which may have changed by now.
            if (typeof lastRun.strategyKey === "string" && lastRun.strategyKey) {
                this.lastRunStrategyKey = lastRun.strategyKey;
            }
            this.serverHasArtifacts = lastRun.hasArtifacts === true;
            this.pendingServerRunCacheStats = lastRun.cacheStats
                ? buildCacheStatsFromLoader(lastRun.cacheStats)
                : null;

            // Reconcile missing rows. The browser holds the streamed prefix
            // (whatever arrived before the disconnect); the server retains the
            // FULL scalar row list in `runState.rows` for the artifact lifetime
            // and now exposes it via `lastRun` pagination. Page from the current
            // browser offset up to the server rowCount so Copy / benchmark /
            // snapshot describe the complete run, not just the prefix that
            // reached the browser (audit finding 3).
            const serverRowCount = Math.max(0, Math.floor(Number(lastRun.rowCount ?? 0)));
            let firstDelivered: BatchBacktestSymbolResult[] = [];
            let nextOffset: number | null = null;
            if (Array.isArray(lastRun.rows)) {
                const rowOffset = Math.max(0, Math.floor(Number(lastRun.rowOffset ?? 0)));
                firstDelivered = lastRun.rows;
                nextOffset = lastRun.nextOffset === undefined ? null : lastRun.nextOffset;
                for (let i = 0; i < firstDelivered.length; i += 1) {
                    const absoluteIndex = rowOffset + i;
                    if (absoluteIndex < this.lastResults.length) continue;
                    this.lastResults.push(firstDelivered[i]!);
                    this.appendedCount += 1;
                }
            }
            if (firstDelivered.length > 0) {
                this.appendResultRows(dom, firstDelivered);
            }

            // Drain remaining pages from the server offset until the server
            // signals no more rows (`nextOffset === null`). The status endpoint
            // bounds rows-per-response and returns `nextOffset` only when more
            // remain; the non-progressing-cursor guard below + the absolute
            // row-count / iteration caps prevent a misbehaving server from
            // looping the browser forever.
            let guard = 0;
            while (
                typeof nextOffset === "number"
                && this.lastResults.length < serverRowCount
                && this.lastResults.length < MAX_ROWS_TO_RECONSTRUCT
                && guard < MAX_ROWS_TO_RECONSTRUCT
            ) {
                guard += 1;
                const pageResponse = await fetch(
                    `/api/batch-backtest/status?after=${nextOffset}&limit=${PAGE_LIMIT}`,
                    { cache: "no-store" },
                );
                if (!pageResponse.ok) break;
                const pagePayload = await pageResponse.json() as {
                    lastRun?: {
                        rows?: BatchBacktestSymbolResult[];
                        rowOffset?: number;
                        nextOffset?: number | null;
                    } | null;
                };
                const page = pagePayload.lastRun;
                if (!page || !Array.isArray(page.rows) || page.rows.length === 0) break;
                const pageOffset = Math.max(0, Math.floor(Number(page.rowOffset ?? nextOffset)));
                const pageRows: BatchBacktestSymbolResult[] = [];
                for (let i = 0; i < page.rows.length; i += 1) {
                    const absoluteIndex = pageOffset + i;
                    if (absoluteIndex < this.lastResults.length + pageRows.length) continue;
                    pageRows.push(page.rows[i]!);
                }
                for (const row of pageRows) {
                    this.lastResults.push(row);
                    this.appendedCount += 1;
                }
                if (pageRows.length > 0) {
                    this.appendResultRows(dom, pageRows);
                }
                nextOffset = page.nextOffset === undefined ? null : page.nextOffset;
                if (page.nextOffset !== null && page.nextOffset !== undefined
                    && page.nextOffset <= pageOffset + page.rows.length) {
                    break; // non-progressing cursor guard
                }
            }

            setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
            this.saveLatestResultsSnapshot();
            if (serverRowCount > 0 && this.lastResults.length < serverRowCount) {
                // Reconstruction could not reach the server's row count — surface
                // the gap visibly instead of presenting partial data as complete.
                debugLogger.warn("batch.server.recover_rows_incomplete", {
                    recovered: this.lastResults.length,
                    serverRowCount,
                });
                return `Done (incomplete: ${this.lastResults.length}/${serverRowCount} pairs — stream truncated, some rows unrecoverable)`;
            }
            return `Done (${this.lastResults.length} pairs)`;
        } catch (error) {
            debugLogger.warn("batch.server.recover_completed_run_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Benchmark capture. Each phase records wall clock + cache stats; the
    // Copy Benchmark button pretty-prints the accumulated snapshot to the
    // clipboard as JSON (mirrors Finder's Copy Diagnostics).
    // ─────────────────────────────────────────────────────────────────────

    private recordRunBenchmark(
        mode: "browser" | "server",
        strategyKey: string,
        interval: string,
        startedAt: number,
    ): void {
        const totalMs = performance.now() - startedAt;
        // Classify pairs by synthetic vs real. parsePortfolioSyntheticPairSymbol
        // returns non-null only for `BASE+QUOTE` tokens.
        let synthetic = 0;
        let real = 0;
        for (const row of this.lastResults) {
            if (parsePortfolioSyntheticPairSymbol(row.symbol)) synthetic += 1;
            else real += 1;
        }
        const loaded = this.lastResults.filter((r) => r.status !== "load_failed" && r.status !== "run_failed").length;
        const failed = this.lastResults.length - loaded;
        const phase: BatchBenchmarkRunPhase = {
            totalMs,
            loaded,
            failed,
            synthetic,
            real,
            avgMsPerLoaded: benchmarkRatio(totalMs, loaded),
        };
        const cacheSource = this.resolveCacheSource(mode);
        const cache = cacheSource === "server_stream" && this.pendingServerRunCacheStats
            ? this.pendingServerRunCacheStats
            : cacheSource === "browser_loader"
                ? this.currentCacheStats()
                : this.emptyCacheStats();
        const existing = this.lastBenchmark;
        const snapshot: BatchBenchmarkSnapshot = {
            schema: BATCH_BENCHMARK_SCHEMA,
            run: {
                mode,
                strategy: strategyKey,
                interval,
                engineMode: shouldUseRustEngine() ? "rust_preferred" : "typescript",
                executedAt: new Date().toISOString(),
            },
            cacheSource,
            phases: { run: phase, mine: existing?.phases.mine ?? null, stability: existing?.phases.stability ?? null },
            cache,
            bottlenecks: [],
        };
        snapshot.bottlenecks = buildBatchBenchmarkBottlenecks(snapshot.phases, snapshot.cache, snapshot.cacheSource);
        this.lastBenchmark = snapshot;
        const dom = this.dom;
        if (dom) dom.batchBacktestCopyBenchmarkBtn.disabled = false;
    }

    private recordMineBenchmark(startedAt: number, targetCount: number): void {
        const totalMs = performance.now() - startedAt;
        const verdicts = this.lastMinerResult?.verdicts.length ?? 0;
        const phase: BatchBenchmarkMinePhase = {
            totalMs,
            targets: Math.max(0, Math.floor(targetCount)),
            verdicts,
            avgMsPerTarget: benchmarkRatio(totalMs, targetCount),
            avgMsPerVerdict: benchmarkRatio(totalMs, verdicts),
        };
        this.mergePhase({ mine: phase });
    }

    private recordStabilityBenchmark(startedAt: number): void {
        const totalMs = performance.now() - startedAt;
        const result = this.lastStabilityResult;
        if (!result) return;
        const sampledPairEvaluations = Math.max(0, Math.floor(result.reruns * result.subsetSize));
        const hitEvents = Math.max(0, Math.floor(result.hitEvents));
        const phase: BatchBenchmarkStabilityPhase = {
            totalMs,
            reruns: result.reruns,
            subsetSize: result.subsetSize,
            totalPairs: result.totalPairs,
            sampledPairEvaluations,
            targetAssets: result.targetAssets,
            targets: result.rows.length,
            verdicts: result.rows.length,
            hitEvents,
            avgMsPerRerun: benchmarkRatio(totalMs, result.reruns),
            avgMsPerSampledPair: benchmarkRatio(totalMs, sampledPairEvaluations),
            hitEventsPerRerun: benchmarkRatio(hitEvents, result.reruns, 3),
            hitEventsPerSampledPair: benchmarkRatio(hitEvents, sampledPairEvaluations, 5),
            minerProfile: result.minerProfile ?? null,
            // Phase 6 engine reporting. Default the omitted/legacy field to the
            // sequential TypeScript engine so the benchmark always reports a
            // concrete engine, even for results produced before this field existed.
            engine: result.engine ?? "typescript",
        };
        this.mergePhase({ stability: phase });
    }

    private mergePhase(patch: { mine?: BatchBenchmarkMinePhase } | { stability?: BatchBenchmarkStabilityPhase }): void {
        const existing = this.lastBenchmark;
        if (!existing) {
            // No run phase yet (shouldn't happen because Mine/Stability require
            // a prior Run, but be defensive). Drop the patch.
            return;
        }
        const phases = { ...existing.phases, ...patch };
        // Browser Mine can add local loader traffic. Server Mine runs in Node
        // and the browser cannot observe its loader counters, so preserve the
        // server stats captured at run completion.
        const cache = existing.run.mode === "server" ? existing.cache : this.currentCacheStats();
        const snapshot: BatchBenchmarkSnapshot = { ...existing, phases, cache, bottlenecks: [] };
        snapshot.bottlenecks = buildBatchBenchmarkBottlenecks(snapshot.phases, snapshot.cache, snapshot.cacheSource);
        this.lastBenchmark = snapshot;
    }

    private resolveCacheSource(mode: "browser" | "server"): BatchBenchmarkCacheSource {
        if (mode === "browser") return "browser_loader";
        return this.pendingServerRunCacheStats ? "server_stream" : "unavailable";
    }

    private currentCacheStats(): BatchBenchmarkCacheStats {
        // Browser path: in-memory LRU populated; disk counters stay 0. Server
        // runs pass server-side stats through `pendingServerRunCacheStats`.
        return buildCacheStatsFromLoader(getBatchDatasetCacheStats());
    }

    private emptyCacheStats(): BatchBenchmarkCacheStats {
        return buildCacheStatsFromLoader({
            leg: { hits: 0, misses: 0, size: 0, max: 24 },
            pair: { hits: 0, misses: 0, size: 0, max: 16 },
            disk: { hits: 0, misses: 0, writes: 0 },
        });
    }

    private async copyBenchmarkPerformance(): Promise<void> {
        if (!this.lastBenchmark) {
            uiManager.showToast("No benchmark to copy", "info");
            return;
        }
        const text = JSON.stringify(this.lastBenchmark, null, 2);
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast("Benchmark copied", "success");
        } else {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    private async copyResults(): Promise<void> {
        if (this.lastResults.length === 0) return;
        const text = formatBatchOverallSummary(this.lastResults).join("\n");
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * Persist the latest Mine Timing verdicts to the local SQLite store so the
     * Assets tab can rank assets by timing edge. Fire-and-forget on purpose —
     * persistence failure must not block the Mine UI path; the user already
     * has the verdicts rendered. Strategy key comes from `lastRunStrategyKey`
     * (captured at run start) so it reflects the strategy that actually
     * governed the run, not whatever is selected at Mine-click time.
     */
    private persistMineTimingResult(source: "mine" | "stability"): void {
        const interval = this.lastRunInterval ?? state.currentInterval;
        // Mine verdicts must be labeled with the strategy that actually
        // governed the Run. Previously this fell back to `state.currentStrategyKey`
        // when `lastRunStrategyKey` was null — which after a tab reload (before
        // this fix, the snapshot never stored the key) silently attributed
        // verdicts to whatever strategy the user happened to select next,
        // corrupting the Assets/timing-edge history (audit finding 5).
        //
        // Refuse + warn: skip persistence entirely when provenance cannot be
        // established. Mine verdicts still render in the UI (persistence is
        // fire-and-forget); the Assets DB simply does not gain mislabeled rows.
        if (!this.lastRunStrategyKey) {
            debugLogger.warn("batch.mine_timing.persist_skipped_no_strategy_key", {
                source,
                reason: "lastRunStrategyKey is null — Run provenance not captured (reload before snapshot stored the key, or Run never completed). Skipping persistence instead of attributing verdicts to the current UI strategy.",
            });
            return;
        }
        const strategyKey = this.lastRunStrategyKey;
        const runId = `mt-${source}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // Build the run descriptor for the given source, then hand it to the
        // shared persistence path. Splitting by source here keeps the snapshot
        // projection (mine vs stability) explicit; the store/load path is
        // identical for both.
        let run: TimingEdgePersistedRun;
        if (source === "mine") {
            if (!this.lastMinerResult || this.lastMinerResult.verdicts.length === 0) return;
            const validVerdicts = this.lastMinerResult.verdicts.filter((verdict) => {
                const lag = computeStabilityDataLagBars(verdict.currentSnapshot?.timeKey ?? null, interval);
                return lag !== null && lag <= STABILITY_DATA_STALE_THRESHOLD_BARS;
            });
            run = {
                runId,
                createdAt: Date.now(),
                interval,
                strategyKey,
                source: "mine",
                pairCount: this.lastResults.length,
                reruns: 0,
                subsetSize: 0,
                seed: 0,
                verdicts: validVerdicts.map(projectMineVerdictToSnapshot),
            };
        } else {
            if (!this.lastStabilityResult || this.lastStabilityResult.rows.length === 0) return;
            const validRows = this.lastStabilityResult.rows.filter((row) => {
                const action = computeStabilityAction(row, this.lastStabilityResult!.reruns, interval).action;
                return action === "ENTER" || action === "WATCH";
            });
            run = {
                runId,
                createdAt: Date.now(),
                interval,
                strategyKey,
                source: "stability",
                pairCount: this.lastResults.length,
                reruns: this.lastStabilityResult.reruns,
                subsetSize: this.lastStabilityResult.subsetSize,
                seed: this.lastStabilityResult.seed,
                verdicts: validRows.map(projectStabilityRowToSnapshot),
            };
        }
        // storeMineTimingRun RESOLVES FALSE on HTTP failure (it doesn't throw),
        // so a `.catch` alone swallows the most common failure mode silently.
        // Await the boolean and log loudly when persistence fails — silent
        // failure here looks exactly like "empty Assets tab" in the UI.
        void storeMineTimingRun(run).then((ok) => {
            if (!ok) {
                debugLogger.warn("batch.mine_timing.persist_failed", {
                    source,
                    runId,
                    verdicts: run.verdicts.length,
                    reason: "store returned false (HTTP error, server route missing, or SQLite unavailable)",
                });
            } else {
                debugLogger.event("batch.mine_timing.persisted", {
                    source,
                    runId,
                    verdicts: run.verdicts.length,
                });
            }
        }).catch((error) => {
            debugLogger.warn("batch.mine_timing.persist_threw", {
                source,
                runId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    private async runMiner(): Promise<void> {
        const dom = this.getDom();
        if (this.lastResults.length === 0 && !this.serverHasArtifacts) {
            dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
            return;
        }
        if (!this.lastRunFingerprint) {
            dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }
        if (!this.serverHasArtifacts) {
            const currentFingerprint = this.buildCurrentRunFingerprint();
            if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
                dom.batchBacktestCopyMinerBtn.disabled = true;
                return;
            }
        }

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = this.serverHasArtifacts ? "Mining on server..." : "Loading target assets...";
        dom.batchBacktestMinerResults.replaceChildren();

        // Server-side mode: artifacts live on the server. Stream verdicts back
        // via the `/api/batch-backtest/mine` NDJSON endpoint. The browser only
        // reconstructs the per-verdict rows; it never holds the pair artifacts
        // (data/signals/result.trades) that the server-side Run kept.
        if (this.serverHasArtifacts) {
            const mineStartedAt = performance.now();
            const targetCount = await this.runMinerServer(dom);
            this.recordMineBenchmark(mineStartedAt, targetCount);
            return;
        }

        const pairArtifacts = this.buildMinerPairArtifacts();
        if (pairArtifacts.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "No completed synthetic pair artifacts to mine.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }

        try {
            const targets = await this.loadMinerTargets(pairArtifacts, this.lastRunInterval ?? state.currentInterval);
            if (targets.length === 0) {
                this.lastMinerResult = null;
                dom.batchBacktestMinerSummary.textContent = "No target asset candles loaded.";
                return;
            }
            dom.batchBacktestMinerSummary.textContent = "Mining timing analogs...";
            const mineStartedAt = performance.now();
            const result = runBatchSyntheticStateMiner({
                interval: this.lastRunInterval ?? state.currentInterval,
                targets,
                artifacts: pairArtifacts,
            });
            this.lastMinerResult = result;
            this.renderMinerResult(dom, result);
            dom.batchBacktestCopyMinerBtn.disabled = result.verdicts.length === 0;
            this.recordMineBenchmark(mineStartedAt, targets.length);
            this.persistMineTimingResult("mine");
            debugLogger.event("batch_synthetic_miner.complete", {
                pairs: pairArtifacts.length,
                targets: targets.length,
                verdicts: result.verdicts.length,
            });
            // The miner was the last consumer of the per-row OHLCV / signal /
            // trade arrays. Drop them so a 1000-pair run doesn't keep ~5 GB
            // of artifacts alive after Mine. Scalars, tradeSummary, and the
            // DOM rows are unaffected, so the result list and Copy summary
            // render. Re-mining the same run now requires a fresh Run, which
            // matches the existing fingerprint guard.
            for (const row of this.lastResults) {
                row.data = undefined;
                row.signals = undefined;
                if (row.result) {
                    row.result.trades = [];
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            // The leg/pair caches existed to feed Mine; the miner reads
            // pairArtifacts into its own working set on entry, so the shared
            // LRU no longer needs the resolved arrays. Drop them so the next
            // action (Copy, new Run, tab work) doesn't carry them.
            clearBatchDatasetCaches();
        }
    }

    /**
     * Server-side Mine path: stream verdicts from `/api/batch-backtest/mine`.
     * The server retains artifacts from the run; the browser only reconstructs
     * per-verdict rows for display. After completion the server releases its
     * artifact copy and the browser-side `serverHasArtifacts` flag is cleared
     * so the user must Run again before re-mining (mirrors the fingerprint
     * guard on the browser path).
     */
    private async runMinerServer(dom: BatchBacktestDom): Promise<number> {
        // Returns the target asset count (from the `start` event) so the
        // caller can pass it to `recordMineBenchmark`. Defaults to 0 on error.
        // Declared outside `try` so the `finally`-adjacent return can read it.
        let targetCount = 0;
        try {
            const response = await fetch("/api/batch-backtest/mine", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval,
                }),
            });
            if (!response.ok || !response.body) {
                const text = await response.text();
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore */ }
                throw new Error(payload.error ?? `Server mine failed (${response.status}).`);
            }
            const verdicts: BatchSyntheticAssetVerdict[] = [];
            let minerInterval = this.lastRunInterval ?? state.currentInterval;
            // `requireTerminal: true` enforces the protocol invariant: a clean
            // EOF before `done`/`fatal` throws `StreamEndedBeforeTerminalError`,
            // so reaching the line after `consumeNdjsonStream` resolves proves
            // `done` was processed (the only terminal that doesn't throw via
            // `onFatal`). Without this, a truncated stream resolved normally and
            // partial verdicts were committed as a complete Mine run (same root
            // cause as the Batch Run path). Mirrors the Stability Mine path's
            // `received.result` guard.
            // targetCount declared on the function scope; updated in the
            // `start` event handler below.
            await consumeNdjsonStream<BatchMinerStreamEvent>(response.body, {
                onStart: (event: Extract<BatchMinerStreamEvent, { type: "start" }>) => {
                    targetCount = Math.max(0, Math.floor(event.assets ?? 0));
                    dom.batchBacktestMinerSummary.textContent = `Mining on server — ${event.assets} assets / ${event.pairs} pairs`;
                },
                onVerdict: (event: Extract<BatchMinerStreamEvent, { type: "verdict" }>) => {
                    verdicts.push(event.verdict);
                    dom.batchBacktestMinerResults.appendChild(this.createMinerRow(event.verdict));
                },
                onDone: (event: Extract<BatchMinerStreamEvent, { type: "done" }>) => {
                    dom.batchBacktestMinerSummary.textContent = event.summary;
                },
                onFatal: (event: Extract<BatchMinerStreamEvent, { type: "fatal" }>) => {
                    throw new Error(event.error);
                },
            }, { requireTerminal: true });
            this.lastMinerResult = {
                interval: minerInterval,
                options: BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
                verdicts,
                diagnostics: [],
            };
            dom.batchBacktestMinerSummary.textContent = formatMinerSummary(this.lastMinerResult);
            dom.batchBacktestCopyMinerBtn.disabled = verdicts.length === 0;
            this.persistMineTimingResult("mine");
            // Server has released its artifacts; Mine cannot run again until a
            // new server-side Run produces them.
            this.serverHasArtifacts = false;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.server_failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
        }
        return targetCount;
    }

    private async stopServerRun(): Promise<void> {
        try {
            await fetch("/api/batch-backtest/stop", { method: "POST" });
        } catch (error) {
            debugLogger.warn("batch.server.stop_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Read the `batchExecutionMode` select. Mirrors how `getEnginePreference`
     * reads `useRustEngineToggle` directly from the DOM — both ids live in the
     * `Backend Engine` settings section. Returns `"server"` when the select is
     * missing (default is server-side; see settings-model.ts).
     */
    private readBatchExecutionMode(): "server" | "browser" {
        const select = document.getElementById("batchExecutionMode") as HTMLSelectElement | null;
        if (!select) return "server";
        return select.value === "browser" ? "browser" : "server";
    }

    private stopReattachPoll(): void {
        this.reattachPollingStopped = true;
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer);
            this.reattachTimer = null;
        }
        if (this.reattachTimerResolve) {
            this.reattachTimerResolve();
            this.reattachTimerResolve = null;
        }
    }

    /**
     * Polls `GET /api/batch-backtest/status` on init. If a run is in flight on
     * the server (started before this tab opened), renders the snapshot rows
     * accumulated so far and long-polls every 2s until the run ends, then
     * renders the final summary. Mirrors IBKR sync's reattach pattern.
     *
     * Granularity is 2s (not per-symbol) because the server's NDJSON stream is
     * owned by the connection that started the run; this poll snapshots the
     * shared in-progress state instead of tapping the stream from a second
     * connection. Single-user dev server, so a multi-subscriber stream tap is
     * not worth the complexity.
     *
     * Polling is unbounded: a 1000-pair server-side run can outlast the prior
     * 5-minute cap, which stranded the UI while Node kept working. Lifetime is
     * gated by the server's `running` flag, `stopReattachPoll()` (Stop button /
     * dispose / a new Run), and a 2s→5s step-down after 5 minutes to shed idle
     * load on very long runs.
     */
    private async reattachToInProgressServerRun(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        const LONG_POLL_INTERVAL_MS = 5000;
        const FAST_POLL_COUNT = 150; // 5 minutes at 2s before stepping down to 5s.
        this.reattachPollingStopped = false;
        try {
            for (let poll = 0; ; poll += 1) {
                if (this.reattachPollingStopped) {
                    // stopReattachPoll() ran between iterations (Stop / dispose / new Run).
                    return;
                }
                const response = await fetch(`/api/batch-backtest/status?after=${this.lastResults.length}`, { cache: "no-store" });
                const payload = await response.json() as {
                    running?: boolean;
                    run?: {
                        total: number;
                        completed: number;
                        failed: number;
                        currentSymbol: string | null;
                        cancelled: boolean;
                        interval: string;
                        strategyKey: string;
                        rows: BatchBacktestSymbolResult[];
                        rowOffset?: number;
                        rowCount?: number;
                        nextOffset?: number | null;
                    } | null;
                    lastRun?: {
                        rowCount: number;
                        hasArtifacts: boolean;
                        fingerprint: string | null;
                        interval?: string | null;
                        strategyKey?: string | null;
                        cacheStats?: BatchDatasetCacheStats | null;
                    } | null;
                };
                if (!payload.running || !payload.run) {
                    // Adopt any leftover server-side artifacts (Mine Timing
                    // can still run against the prior run if it hasn't TTL'd).
                    if (
                        payload.lastRun
                        && payload.lastRun.hasArtifacts
                        && payload.lastRun.fingerprint
                        && (this.lastRunFingerprint === null || this.lastRunFingerprint === payload.lastRun.fingerprint)
                    ) {
                        this.serverHasArtifacts = true;
                        this.lastRunFingerprint = payload.lastRun.fingerprint;
                        this.lastRunInterval = payload.lastRun.interval ?? null;
                        // Adopt the governing strategy so Mine provenance survives
                        // a tab reload (audit finding 5). The server already
                        // emits `lastRun.strategyKey`; previously it was dropped
                        // here, so Mine fell back to the current UI strategy.
                        if (typeof payload.lastRun.strategyKey === "string" && payload.lastRun.strategyKey) {
                            this.lastRunStrategyKey = payload.lastRun.strategyKey;
                        }
                        // Adopt the server-side cache counters so a tab-reload
                        // reattach still produces a useful benchmark snapshot
                        // (mirrors `recoverCompletedServerRun`'s handling).
                        this.pendingServerRunCacheStats = payload.lastRun.cacheStats
                            ? buildCacheStatsFromLoader(payload.lastRun.cacheStats)
                            : null;
                        // The browser does not have the per-row scalars for the
                        // prior run (the tab reloaded), but server-side Mine
                        // and Stability Mine can still consume retained
                        // artifacts before their TTL expires.
                        this.getDom().batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
                        this.getDom().batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
                    }
                    if (this.lastResults.length > 0) {
                        this.saveLatestResultsSnapshot();
                    }
                    return;
                }
                const run = payload.run;
                this.serverHasArtifacts = false; // still running; Mine not yet available.
                // Adopt the in-progress run's governing strategy so Mine
                // provenance is correct even on the very first reattach tick
                // (audit finding 5). `run.strategyKey` is always present while
                // a run is active.
                if (typeof run.strategyKey === "string" && run.strategyKey) {
                    this.lastRunStrategyKey = run.strategyKey;
                }
                const dom = this.getDom();
                dom.batchBacktestRunBtn.disabled = true;
                setVisible(dom.batchBacktestStopBtn, true);
                const rowOffset = Math.max(0, Math.floor(Number(run.rowOffset ?? 0)));
                if (rowOffset === 0 && this.lastResults.length === 0 && run.rows.length > 0) {
                    dom.batchBacktestResults.replaceChildren();
                }
                // Drain pages until the server signals no more rows for this
                // tick. The status endpoint bounds rows-per-response (default
                // 250) and returns `nextOffset` when more remain; without this
                // drain a late reload would catch up at one page per 2s poll.
                // Reconciliation is unchanged (absolute index, skip seen), so
                // any page boundary is safe. New rows accumulate in a buffer
                // and append as one DocumentFragment (see appendResultRows).
                // Paged responses only need the reconcile fields, so the
                // structural type here is intentionally narrower than the
                // initial `run` shape (which carries status scalars too).
                const pendingRows: BatchBacktestSymbolResult[] = [];
                let page: { rows: BatchBacktestSymbolResult[]; rowOffset?: number; nextOffset?: number | null } = run;
                for (;;) {
                    const pageOffset = Math.max(0, Math.floor(Number(page.rowOffset ?? 0)));
                    for (let i = 0; i < page.rows.length; i += 1) {
                        const absoluteIndex = pageOffset + i;
                        if (absoluteIndex < this.lastResults.length + pendingRows.length) continue;
                        pendingRows.push(page.rows[i]!);
                    }
                    const nextOffset = page.nextOffset;
                    if (nextOffset === null || nextOffset === undefined) break;
                    if (nextOffset <= pageOffset + page.rows.length) break; // guard against non-progressing cursors
                    if (!payload.running || !payload.run) break;
                    const nextResponse = await fetch(`/api/batch-backtest/status?after=${nextOffset}&limit=250`, { cache: "no-store" });
                    if (!nextResponse.ok) break;
                    const nextPayload = await nextResponse.json() as { run?: { rows: BatchBacktestSymbolResult[]; rowOffset?: number; nextOffset?: number | null } | null };
                    if (!nextPayload.run) break;
                    page = nextPayload.run;
                }
                if (pendingRows.length > 0) {
                    for (const row of pendingRows) {
                        this.lastResults.push(row);
                        this.appendedCount += 1;
                    }
                    this.appendResultRows(dom, pendingRows);
                }
                const seen = run.completed + run.failed;
                const current = run.currentSymbol ? ` — ${run.currentSymbol}` : "";
                dom.batchBacktestStatus.textContent = `Server run ${seen}/${run.total}${current}`;
                this.setProgress(dom, run.total > 0 ? (seen / run.total) * 100 : 0, `${seen}/${run.total}`);
                const delay = poll < FAST_POLL_COUNT ? POLL_INTERVAL_MS : LONG_POLL_INTERVAL_MS;
                await new Promise<void>((resolve) => {
                    this.reattachTimerResolve = resolve;
                    this.reattachTimer = setTimeout(resolve, delay);
                });
                this.reattachTimer = null;
                this.reattachTimerResolve = null;
            }
        } catch (error) {
            debugLogger.warn("batch.server.reattach_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.stopReattachPoll();
        }
    }

    private async copyMinerResults(): Promise<void> {
        if (!this.lastMinerResult) return;
        const text = formatMinerCopy(this.lastMinerResult);
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.getDom().batchBacktestMinerSummary.textContent = "Copy miner failed.";
        }
    }

    private async runStabilityMine(): Promise<void> {
        const dom = this.getDom();
        if (this.lastResults.length === 0 && !this.serverHasArtifacts) {
            dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
            return;
        }
        const currentFingerprint = this.buildCurrentRunFingerprint();
        if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
            dom.batchBacktestMinerSummary.textContent = "Rerun Batch before stability mining; settings or symbols changed.";
            dom.batchBacktestCopyStabilityBtn.disabled = true;
            return;
        }
        const pairArtifacts = this.buildMinerPairArtifacts();
        if (this.serverHasArtifacts && pairArtifacts.length === 0) {
            const hasServerArtifacts = await this.refreshServerArtifactState(currentFingerprint);
            if (!hasServerArtifacts) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before stability mining; no artifacts on server.";
                dom.batchBacktestStabilityMineBtn.disabled = true;
                return;
            }
            const stabilityStartedAt = performance.now();
            await this.runStabilityMineServer(dom);
            this.recordStabilityBenchmark(stabilityStartedAt);
            return;
        }
        if (pairArtifacts.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "No completed synthetic pair artifacts to stability mine.";
            dom.batchBacktestCopyStabilityBtn.disabled = true;
            return;
        }

        const subsetSize = this.readClampedInt(dom.batchBacktestStabilitySubsetSize.value, 200, 10, pairArtifacts.length);
        const reruns = this.readClampedInt(dom.batchBacktestStabilityReruns.value, 50, 1, 200);
        const seed = this.readClampedInt(dom.batchBacktestStabilitySeed.value, 1, 1, Number.MAX_SAFE_INTEGER);
        dom.batchBacktestStabilitySubsetSize.value = String(subsetSize);
        dom.batchBacktestStabilityReruns.value = String(reruns);
        dom.batchBacktestStabilitySeed.value = String(seed);

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = "Loading target assets for stability mine...";
        dom.batchBacktestMinerResults.replaceChildren();

        try {
            const targets = await this.loadMinerTargets(pairArtifacts, this.lastRunInterval ?? state.currentInterval);
            if (targets.length === 0) {
                this.lastStabilityResult = null;
                dom.batchBacktestMinerSummary.textContent = "No target asset candles loaded.";
                return;
            }

            // Pre-run freshness warning. Each target's last bar IS the AsOf the
            // miner will snapshot, so its lag predicts whether every row will be
            // vetoed `INVALID | DATA_STALE` before we spend ~60s on reruns. This
            // only warns — the run continues so the analog distribution can still
            // be inspected while iterating on the algorithm.
            const interval = this.lastRunInterval ?? state.currentInterval;
            const maxLagBars = computeMaxTargetLagBars(targets, interval);
            if (maxLagBars !== null && maxLagBars > STABILITY_DATA_STALE_THRESHOLD_BARS) {
                dom.batchBacktestMinerSummary.textContent = `Data STALE — max lag ${maxLagBars.toFixed(1)}b (threshold ${STABILITY_DATA_STALE_THRESHOLD_BARS}b). Stability run continuing, but every Action will be INVALID until OHLCV is refreshed.`;
            }

            const stabilityStartedAt = performance.now();
            const aggregate = createStabilityAggregate(reruns, subsetSize, seed, pairArtifacts.length, targets.length);
            const minerProfile = createBatchSyntheticMinerProfile();
            let profileStartedAt = performance.now();
            const preparedTargets = prepareBatchSyntheticTargetArtifacts(targets);
            minerProfile.prepareTargetsMs += performance.now() - profileStartedAt;
            profileStartedAt = performance.now();
            const preparedPairs = prepareBatchSyntheticPairArtifacts(pairArtifacts);
            minerProfile.preparePairsMs += performance.now() - profileStartedAt;
            for (let runIndex = 0; runIndex < reruns; runIndex += 1) {
                const subset = sampleItems(preparedPairs, subsetSize, seed + runIndex);
                const subsetAssets = new Set(subset.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset]));
                profileStartedAt = performance.now();
                const subsetTargets = preparedTargets.filter((target) => subsetAssets.has(target.asset));
                minerProfile.subsetTargetFilterMs += performance.now() - profileStartedAt;
                const result = runPreparedBatchSyntheticStateMiner({
                    interval: this.lastRunInterval ?? state.currentInterval,
                    targets: subsetTargets,
                    artifacts: subset,
                    profile: minerProfile,
                });
                addStabilityVerdicts(aggregate, result.verdicts);
                dom.batchBacktestMinerSummary.textContent = `Stability mining ${runIndex + 1}/${reruns} | hits ${aggregate.hitEvents}`;
                if ((runIndex + 1) % 5 === 0) {
                    await yieldToUi();
                }
            }

            this.lastStabilityResult = finalizeStabilityAggregate(aggregate);
            this.lastStabilityResult.minerProfile = minerProfile;
            this.renderStabilityResult(dom, this.lastStabilityResult);
            dom.batchBacktestCopyStabilityBtn.disabled = this.lastStabilityResult.rows.length === 0;
            this.recordStabilityBenchmark(stabilityStartedAt);
            this.persistMineTimingResult("stability");
            this.saveLatestResultsSnapshot();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastStabilityResult = null;
            dom.batchBacktestMinerSummary.textContent = `Stability miner error: ${message}`;
            debugLogger.error("batch_stability_miner.failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.hasMineableArtifacts();
            clearBatchDatasetCaches();
        }
    }

    private async runStabilityMineServer(dom: BatchBacktestDom): Promise<void> {
        const subsetSize = this.readClampedInt(dom.batchBacktestStabilitySubsetSize.value, 200, 10, Number.MAX_SAFE_INTEGER);
        const reruns = this.readClampedInt(dom.batchBacktestStabilityReruns.value, 50, 1, 200);
        const seed = this.readClampedInt(dom.batchBacktestStabilitySeed.value, 1, 1, Number.MAX_SAFE_INTEGER);
        dom.batchBacktestStabilitySubsetSize.value = String(subsetSize);
        dom.batchBacktestStabilityReruns.value = String(reruns);
        dom.batchBacktestStabilitySeed.value = String(seed);

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = "Stability mining on server...";
        dom.batchBacktestMinerResults.replaceChildren();
        this.lastStabilityResult = null;

        try {
            const response = await fetch("/api/batch-backtest/stability-mine", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval ?? state.currentInterval,
                    subsetSize,
                    reruns,
                    seed,
                }),
            });
            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => "");
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore */ }
                if (response.status === 400 && payload.error?.includes("no artifacts on server")) {
                    this.serverHasArtifacts = false;
                }
                throw new Error(payload.error ?? (text || `HTTP ${response.status}`));
            }
            const received: { result: BatchStabilityMineResult | null; cancelledSummary: string | null } = {
                result: null,
                cancelledSummary: null,
            };
            await consumeNdjsonStream<BatchStabilityMineStreamEvent>(response.body, {
                onProgress: (event: Extract<BatchStabilityMineStreamEvent, { type: "progress" }>) => {
                    dom.batchBacktestMinerSummary.textContent = `Stability mining on server ${event.run}/${event.reruns} | hits ${event.hits}`;
                },
                onDone: (event: Extract<BatchStabilityMineStreamEvent, { type: "done" }>) => {
                    if (event.ok) {
                        received.result = event.result;
                    } else {
                        received.cancelledSummary = event.summary;
                    }
                },
                onFatal: (event: Extract<BatchStabilityMineStreamEvent, { type: "fatal" }>) => {
                    throw new Error(event.error);
                },
            });
            if (received.cancelledSummary) {
                this.lastStabilityResult = null;
                dom.batchBacktestMinerSummary.textContent = received.cancelledSummary;
                return;
            }
            if (!received.result) {
                throw new Error("Server stability mine did not return a result.");
            }
            this.lastStabilityResult = received.result;
            this.renderStabilityResult(dom, received.result);
            dom.batchBacktestCopyStabilityBtn.disabled = received.result.rows.length === 0;
            this.serverHasArtifacts = true;
            this.saveLatestResultsSnapshot();
            this.persistMineTimingResult("stability");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastStabilityResult = null;
            dom.batchBacktestMinerSummary.textContent = `Stability miner error: ${message}`;
            debugLogger.error("batch_stability_miner.server_failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
        }
    }

    private async refreshServerArtifactState(expectedFingerprint: string): Promise<boolean> {
        try {
            const response = await fetch("/api/batch-backtest/status", { cache: "no-store" });
            if (!response.ok) {
                this.serverHasArtifacts = false;
                return false;
            }
            const payload = await response.json() as {
                lastRun?: {
                    hasArtifacts?: boolean;
                    fingerprint?: string | null;
                    interval?: string | null;
                } | null;
            };
            const lastRun = payload.lastRun;
            const hasArtifacts = lastRun?.hasArtifacts === true && lastRun.fingerprint === expectedFingerprint;
            this.serverHasArtifacts = hasArtifacts;
            if (hasArtifacts) {
                this.lastRunFingerprint = expectedFingerprint;
                this.lastRunInterval = lastRun?.interval ?? this.lastRunInterval;
            }
            return hasArtifacts;
        } catch (error) {
            this.serverHasArtifacts = false;
            debugLogger.warn("batch.server.artifact_status_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private async copyStabilityResults(): Promise<void> {
        if (!this.lastStabilityResult) return;
        const text = formatStabilityCopy(this.lastStabilityResult, {
            interval: this.lastRunInterval ?? state.currentInterval,
            strategyKey: this.lastRunStrategyKey,
            fingerprint: this.lastRunFingerprint,
        });
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.getDom().batchBacktestMinerSummary.textContent = "Copy stability failed.";
        }
    }

    private buildMinerPairArtifacts(): BatchSyntheticPairArtifact[] {
        const artifacts: BatchSyntheticPairArtifact[] = [];
        for (const row of this.lastResults) {
            if (!row.result || !row.data || !row.signals) {
                continue;
            }
            const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
            if (!parsed) {
                continue;
            }
            artifacts.push({
                symbol: row.symbol,
                baseAsset: parsed.baseAsset,
                quoteAsset: parsed.quoteAsset,
                baseSymbol: parsed.baseSymbol,
                quoteSymbol: parsed.quoteSymbol,
                data: row.data,
                signals: row.signals,
                result: row.result,
            });
        }
        return artifacts;
    }

    private async loadMinerTargets(
        pairArtifacts: readonly BatchSyntheticPairArtifact[],
        interval: string
    ): Promise<BatchSyntheticTargetArtifact[]> {
        const assets = Array.from(new Set(
            pairArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset])
                .map((asset) => asset.trim().toUpperCase())
                .filter(Boolean)
        )).sort();
        // Resolve each stripped asset back to the symbol the loader expects.
        // Crypto pairs (e.g. ZEC+APT) become `ZECUSDT` via the USDT suffix.
        // Marked legs carry their provider routing inline (bullet `•` for
        // IBKR, diamond `♦` for stock_market_data); for those, the stripped
        // `baseAsset`/`quoteAsset` is NOT a Binance ticker, so appending
        // `USDT` would produce a symbol no provider can serve (the cause of
        // "No target asset candles loaded." on IBKR batches). Prefer the
        // original marked symbol when one survives from the parsed pair.
        const markedSymbolByAsset = new Map<string, string>();
        for (const artifact of pairArtifacts) {
            for (const [asset, symbol] of [
                [artifact.baseAsset, artifact.baseSymbol],
                [artifact.quoteAsset, artifact.quoteSymbol],
            ] as const) {
                const key = asset?.trim().toUpperCase();
                if (key && symbol && !markedSymbolByAsset.has(key)) {
                    markedSymbolByAsset.set(key, symbol);
                }
            }
        }
        // Load target datasets with bounded concurrency. Each load is
        // independent (loadBatchDataset goes through the shared LRU caches and
        // dataManager.fetchDataDetached, both safe under concurrency), and the
        // previous sequential `for...await` serialized ~16 network reads. On 4H
        // each target has a deep history, so this was the dominant wall clock
        // cost of Mine. Bounded at 8 in flight so an 80-asset IBKR/stock batch
        // doesn't pin ~80 full datasets in memory at the same instant.
        // Per-target errors are isolated so one failed asset does not reject
        // the batch.
        const BATCH_MINER_TARGET_LOAD_CONCURRENCY = 8;
        const loaded = await mapWithConcurrencyLimit(
            assets,
            BATCH_MINER_TARGET_LOAD_CONCURRENCY,
            async (asset): Promise<BatchSyntheticTargetArtifact | null> => {
                const symbol = markedSymbolByAsset.get(asset) ?? resolveBatchSyntheticTargetSymbol(asset);
                try {
                    const data = await loadBatchDataset(symbol, interval);
                    if (Array.isArray(data) && data.length > 0) {
                        return { asset, symbol, data };
                    }
                    return null;
                } catch (error) {
                    debugLogger.warn("batch_synthetic_miner.target_load_failed", {
                        asset,
                        symbol,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return null;
                }
            },
        );
        // Preserve the sorted asset order; drop failed/empty loads.
        return loaded.filter((entry): entry is BatchSyntheticTargetArtifact => entry !== null);
    }

    private buildCurrentRunFingerprint(): string | null {
        const strategyKey = state.currentStrategyKey;
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            return null;
        }
        return this.buildRunFingerprint(
            parseBatchSymbols(this.getDom().batchBacktestSymbols.value),
            strategyKey,
            paramManager.getValues(strategy),
            backtestService.getBacktestSettings(),
            backtestService.getCapitalSettings(),
            state.currentInterval
        );
    }

    private buildRunFingerprint(
        symbols: readonly string[],
        strategyKey: string,
        strategyParams: unknown,
        backtestSettings: unknown,
        capitalSettings: unknown,
        interval: string
    ): string {
        return buildBatchRunFingerprint({
            symbols,
            strategyKey,
            strategyParams,
            backtestSettings,
            capitalSettings,
            interval,
        });
    }

    private loadPersistedLatestResults(dom: BatchBacktestDom): void {
        const snapshot = readPersistedJson<BatchBacktestResultsSnapshot | null>({
            ...BATCH_RESULTS_STORAGE,
            fallback: null,
            migrate: ({ data }) => normalizeBatchBacktestResultsSnapshot(data),
            onError: (error) => {
                debugLogger.error("batch_backtest.latest_results_load_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
        if (!snapshot) return;

        this.lastResults = snapshot.results;
        this.lastStabilityResult = snapshot.stabilityResult ?? null;
        this.lastRunFingerprint = snapshot.fingerprint;
        this.lastRunInterval = snapshot.interval || null;
        // Restore the strategy that governed the Run so Mine provenance survives
        // a tab reload (audit finding 5). Older snapshots (pre-`strategyKey`)
        // normalize to `null`; `persistMineTimingResult` skips persistence in
        // that case rather than attributing verdicts to the wrong strategy.
        this.lastRunStrategyKey = snapshot.strategyKey ?? null;
        this.appendedCount = snapshot.results.length;
        // LocalStorage cannot prove server artifact TTL is still valid, and
        // browser-mode heavy arrays are intentionally not restored. Reattach
        // status may re-enable Mine if server artifacts still exist.
        this.serverHasArtifacts = false;

        dom.batchBacktestResults.replaceChildren();
        this.appendResultRows(dom, this.lastResults);
        setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
        dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        if (this.lastStabilityResult) {
            this.renderStabilityResult(dom, this.lastStabilityResult);
            dom.batchBacktestCopyStabilityBtn.disabled = this.lastStabilityResult.rows.length === 0;
        }
        dom.batchBacktestStatus.textContent = `Restored last Batch run (${this.lastResults.length} pairs)`;
        this.setProgress(dom, 100, "Restored");
        debugLogger.event("batch_backtest.latest_results_restored", {
            count: this.lastResults.length,
            interval: this.lastRunInterval,
            savedAt: snapshot.savedAt,
        });
    }

    private saveLatestResultsSnapshot(): void {
        if (this.lastResults.length === 0) {
            return;
        }
        const snapshot = compactBatchBacktestResultsSnapshot({
            savedAt: Date.now(),
            interval: this.lastRunInterval ?? state.currentInterval,
            fingerprint: this.lastRunFingerprint,
            strategyKey: this.lastRunStrategyKey,
            serverHasArtifacts: this.serverHasArtifacts,
            results: this.lastResults,
            stabilityResult: this.lastStabilityResult,
        });
        writePersistedJson({
            ...BATCH_RESULTS_STORAGE,
            data: snapshot,
            onError: (error) => {
                debugLogger.error("batch_backtest.latest_results_save_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
    }

    private clearPersistedLatestResults(): void {
        if (typeof localStorage === "undefined") return;
        try {
            localStorage.removeItem(BATCH_RESULTS_STORAGE.key);
        } catch (error) {
            debugLogger.error("batch_backtest.latest_results_clear_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private hasMineableArtifacts(): boolean {
        return this.lastResults.some((row) => Boolean(row.result && row.data && row.signals && parsePortfolioSyntheticPairSymbol(row.symbol)));
    }

    private clearMinerResults(dom: BatchBacktestDom): void {
        this.lastMinerResult = null;
        this.lastStabilityResult = null;
        dom.batchBacktestMinerSummary.textContent = "Miner idle";
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
    }

    private renderMinerResult(dom: BatchBacktestDom, result: BatchSyntheticMinerResult): void {
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestMinerSummary.textContent = formatMinerSummary(result);
        if (result.verdicts.length === 0) return;
        const fragment = document.createDocumentFragment();
        for (const verdict of result.verdicts) {
            fragment.appendChild(this.createMinerRow(verdict));
        }
        dom.batchBacktestMinerResults.appendChild(fragment);
    }

    private createMinerRow(verdict: BatchSyntheticAssetVerdict): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${getMinerVerdictClass(verdict.verdict)}`;
        badge.textContent = verdict.verdict;
        line.appendChild(badge);
        line.appendChild(document.createTextNode(` ${formatMinerRowPipe(verdict)}`));
        return line;
    }

    private renderStabilityResult(dom: BatchBacktestDom, result: BatchStabilityMineResult): void {
        dom.batchBacktestMinerResults.replaceChildren();
        const interval = this.lastRunInterval ?? state.currentInterval;
        dom.batchBacktestMinerSummary.textContent = formatStabilitySummary(result, {
            interval,
            strategyKey: this.lastRunStrategyKey,
            fingerprint: this.lastRunFingerprint,
        });
        if (result.rows.length === 0) return;
        const fragment = document.createDocumentFragment();
        for (const row of result.rows) {
            const decision = computeStabilityAction(row, result.reruns, interval);
            const line = document.createElement("div");
            line.className = "finder-sub finder-symbol-row";
            const badge = document.createElement("span");
            badge.className = `finder-verdict ${getStabilityActionClass(decision.action)}`;
            badge.textContent = decision.action;
            line.appendChild(badge);
            line.appendChild(document.createTextNode(` ${formatStabilityRow(row, result.reruns, interval)}`));
            fragment.appendChild(line);
        }
        dom.batchBacktestMinerResults.appendChild(fragment);
    }

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    private appendResultRow(dom: BatchBacktestDom, result: BatchBacktestSymbolResult): void {
        dom.batchBacktestResults.appendChild(this.createResultRow(result));
    }

    /**
     * Append many result rows in one DocumentFragment so restore / reattach
     * paths that render hundreds of rows synchronously do a single reflow
     * instead of one per row. Output is identical to calling appendResultRow
     * per element; this is purely a layout-cost optimization for bulk paths.
     * The live server stream stays on appendResultRow (one row per event).
     */
    private appendResultRows(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void {
        if (results.length === 0) return;
        const fragment = document.createDocumentFragment();
        for (const result of results) {
            fragment.appendChild(this.createResultRow(result));
        }
        dom.batchBacktestResults.appendChild(fragment);
    }

    private clearStaleResults(dom: BatchBacktestDom): void {
        this.clearMinerResults(dom);
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.lastRunStrategyKey = null;
        this.serverHasArtifacts = false;
        this.clearPersistedLatestResults();
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        if (this.lastResults.length === 0) return;
        this.lastResults = [];
        this.appendedCount = 0;
        dom.batchBacktestResults.replaceChildren();
        setVisible(dom.batchBacktestEmpty, true);
        dom.batchBacktestCopyBtn.disabled = true;
    }

    private createResultRow(result: BatchBacktestSymbolResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";

        const verdict = computePerformanceVerdict(result.result, result.status);
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${verdict.cssClass}`;
        badge.textContent = verdict.label;
        line.appendChild(badge);

        line.appendChild(document.createTextNode(` ${formatResultRowPipe(result)}`));
        return line;
    }

    // --------------------------------------------------------------------
    // Progress / summary helpers
    // --------------------------------------------------------------------

    private setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        dom.batchBacktestProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.batchBacktestProgressText.textContent = text;
    }

    private resetProgress(dom: BatchBacktestDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.batchBacktestStatus.textContent = "Idle";
    }

    private updateSummary(dom: BatchBacktestDom): void {
        if (this.lastResults.length > 0) {
            dom.batchBacktestSummary.textContent = formatBatchSummaryLine(this.lastResults);
            return;
        }
        const count = parseBatchSymbols(dom.batchBacktestSymbols.value).length;
        dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
    }

    private readClampedInt(raw: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(raw, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        return Math.max(min, Math.min(max, Math.floor(value)));
    }
}

function yieldToUi(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Max OHLCV lag in bars across miner targets, using each target's last bar as
 * its AsOf. Returns null when no target's last-bar time or the interval can be
 * parsed. Reuses `parseTimeToUnixSeconds` + `parseIntervalSeconds` rather than
 * the row-level `computeStabilityDataLagBars` because pre-run we have raw
 * target datasets, not finalized rows with `asOfTimeKey`.
 */
function computeMaxTargetLagBars(
    targets: readonly BatchSyntheticTargetArtifact[],
    interval: string,
    nowMs = Date.now(),
): number | null {
    const intervalSeconds = parseIntervalSeconds(interval);
    if (intervalSeconds === null) return null;
    let maxLag: number | null = null;
    for (const target of targets) {
        const lastBar = target.data[target.data.length - 1];
        if (!lastBar) continue;
        const asOfSeconds = parseTimeToUnixSeconds(lastBar.time);
        if (asOfSeconds === null) continue;
        const lag = Math.max(0, (nowMs / 1000 - asOfSeconds) / intervalSeconds);
        if (maxLag === null || lag > maxLag) maxLag = lag;
    }
    return maxLag;
}

interface StabilityFormatContext {
    interval: string;
    strategyKey: string | null;
    fingerprint: string | null;
}

function formatStabilitySummary(result: BatchStabilityMineResult, context: StabilityFormatContext): string {
    const workers = Math.max(0, Math.floor(result.minerProfile?.parallelWorkerCount ?? 0));
    const freshness = summarizeStabilityDataFreshness(result.rows, context.interval);
    return [
        "Stability",
        `Interval ${context.interval}`,
        `Strategy ${context.strategyKey ?? "--"}`,
        `Context ${shortFingerprint(context.fingerprint)}`,
        `Engine ${result.engine ?? "typescript"}/${workers}`,
        `Runs ${result.reruns}`,
        `Subset ${result.subsetSize}/${result.totalPairs}`,
        `Seed ${result.seed}`,
        `Signals ${result.rows.length}`,
        `Hits ${result.hitEvents}`,
        `Data ${freshness.status}`,
    ].join(" | ");
}

function formatStabilityRow(row: BatchStabilityRow, reruns: number, interval: string): string {
    const decision = computeStabilityAction(row, reruns, interval);
    const freshHits = Math.max(0, Math.floor(Number(row.freshHits) || 0));
    const barsHeld = row.medianBarsHeld === null || !Number.isFinite(row.medianBarsHeld)
        ? "--"
        : `${formatNumber(row.medianBarsHeld, 1)}b`;
    const dataLag = decision.dataLagBars === null ? "--" : `${formatNumber(decision.dataLagBars, 1)}b`;
    return [
        row.asset,
        `Dir ${row.direction}`,
        `Action ${decision.action}`,
        `Why ${decision.reason}`,
        `Score ${formatNumber(row.timingEdgeScore, 1)}`,
        `Gate ${computeStabilityGate(row)}`,
        `AsOf ${row.asOfTimeKey ?? "--"}`,
        `Lag ${dataLag}`,
        `Age ${computeStabilityAgeTag(row)}:${barsHeld}`,
        `Fresh ${freshHits}/${row.hits}`,
        `Px ${formatPrice(row.close)}`,
        `Div ${(row.medianDiversity * 100).toFixed(0)}%`,
        `Anchor ${row.dominantPair ?? "--"}:${(row.dominantPairShare * 100).toFixed(0)}%`,
        `Hit ${row.hits}/${reruns} (${formatPercent((row.hits / Math.max(1, reruns)) * 100)})`,
        `High ${row.high}`,
        `Med ${row.medium}`,
        `Low ${row.low}`,
        `Ret ${formatSignedPercent(row.medianRetPct)}`,
        `Lift ${formatSignedPercent(row.medianLiftPct)}`,
        `RR ${formatRatio(row.medianRr)}`,
        `Dist ${formatNumber(row.medianDist, 2)}`,
        `HMaxLift ${formatSignedPercent(row.medianHmaxLiftPct)}`,
        `PairWarn ${row.pairWarnings}`,
    ].join(" | ");
}

function formatStabilityCopy(result: BatchStabilityMineResult, context: StabilityFormatContext): string {
    const lines = [formatStabilitySummary(result, context)];
    const freshness = summarizeStabilityDataFreshness(result.rows, context.interval);
    if (freshness.status !== "FRESH") {
        lines.push(freshness.text);
    }
    for (const row of result.rows) {
        lines.push(`STABILITY | ${formatStabilityRow(row, result.reruns, context.interval)}`);
    }
    return lines.join("\n");
}

function shortFingerprint(value: string | null): string {
    if (!value) return "--";
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatMinerSummary(result: BatchSyntheticMinerResult): string {
    const counts = new Map<string, number>();
    for (const verdict of result.verdicts) {
        counts.set(verdict.verdict, (counts.get(verdict.verdict) ?? 0) + 1);
    }
    const parts = ["LONG", "SHORT", "WATCH", "SKIP", "INCONCLUSIVE"]
        .map((label) => {
            const count = counts.get(label) ?? 0;
            return count > 0 ? `${label} ${count}` : "";
        })
        .filter(Boolean);
    return `Miner | Assets ${result.verdicts.length}${parts.length > 0 ? ` | ${parts.join(", ")}` : ""}`;
}

function formatMinerRowPipe(verdict: BatchSyntheticAssetVerdict): string {
    const evidence = verdict.evidence;
    const direction = verdict.direction ? verdict.direction.toUpperCase() : "--";
    const reason = verdict.reasons[0] ?? "";
    const mfeMaeRatio = computeMinerMfeMaeRatio(evidence.expectedMfePct, evidence.expectedMaePct);
    const invalidationPrice = computeMinerInvalidationPrice(verdict);
    const targetPrice = computeMinerTargetPrice(verdict);
    const horizonLabel = evidence.horizonBarsAll.length > 1
        ? `Hrz [${evidence.horizonBarsAll.join(",")}]`
        : `Hrz ${evidence.horizonBars}`;
    const parts = [
        verdict.asset,
        `Dir ${direction}`,
        `Conf ${verdict.confidence}`,
        `Age ${computeMinerAgeTag(verdict)}`,
        `AsOf ${verdict.currentSnapshot?.timeKey ?? "--"}`,
        horizonLabel,
        `Analogs ${evidence.analogCount}/${evidence.candidateCount}`,
        `Pre ${evidence.selectionCount}`,
        `PreRet ${formatSignedPercent(evidence.selectionForwardReturnPct)}`,
        `OOS ${evidence.oosCount}`,
        `Ret ${formatSignedPercent(evidence.expectedForwardReturnPct)}`,
        `Lift ${formatSignedPercent(evidence.oosLiftPct)}`,
        `MFE ${formatSignedPercent(evidence.expectedMfePct)}`,
        `MAE ${formatSignedPercent(evidence.expectedMaePct)}`,
        `RR ${formatRatio(mfeMaeRatio)}`,
        `Entry @${formatPrice(verdict.currentSnapshot?.close ?? null)}`,
        `Target ${formatTargetPrice(verdict.direction, targetPrice, evidence.longestHorizonBars, formatPrice)}`,
        `Inv ${formatInvalidationPrice(verdict.direction, invalidationPrice)}`,
        `HMax ${evidence.longestHorizonBars ?? "--"}b Ret ${formatSignedPercent(evidence.longestOosForwardReturnPct)} Lift ${formatSignedPercent(evidence.longestOosLiftPct)}`,
        `Dist ${formatNumber(evidence.avgDistance, 2)}`,
        reason,
    ].filter(Boolean);
    return parts.join(" | ");
}

function formatMinerCopy(result: BatchSyntheticMinerResult): string {
    const lines = [formatMinerSummary(result)];
    for (const verdict of result.verdicts) {
        lines.push(`${verdict.verdict} | ${formatMinerRowPipe(verdict)}`);
        if (verdict.verdict !== "LONG" && verdict.verdict !== "SHORT" && verdict.verdict !== "WATCH") {
            continue;
        }
        const warnings = verdict.pairContributions
            .filter((entry) => entry.label === "dominating" || entry.label === "harmful" || entry.label === "opposing")
            .slice(0, 3)
            .map(formatPairContributionWarning);
        if (warnings.length > 0) {
            lines.push(`PAIR_CHECK | ${verdict.asset} | ${warnings.join(", ")}`);
        }
    }
    return lines.join("\n");
}

function computeMinerMfeMaeRatio(mfePct: number | null, maePct: number | null): number | null {
    if (mfePct === null || maePct === null || !Number.isFinite(mfePct) || !Number.isFinite(maePct)) {
        return null;
    }
    const adverse = Math.abs(maePct);
    if (adverse <= 1e-9) {
        return mfePct > 0 ? Number.POSITIVE_INFINITY : null;
    }
    return mfePct / adverse;
}

function computeMinerInvalidationPrice(verdict: BatchSyntheticAssetVerdict): number | null {
    const close = verdict.currentSnapshot?.close;
    const maePct = verdict.evidence.expectedMaePct;
    if (!verdict.direction || close === null || close === undefined || maePct === null || !Number.isFinite(close) || !Number.isFinite(maePct) || close <= 0) {
        return null;
    }
    const adversePct = Math.abs(maePct) / 100;
    if (verdict.direction === "long") {
        return close * (1 - adversePct);
    }
    return close * (1 + adversePct);
}

function formatInvalidationPrice(direction: BatchSyntheticAssetVerdict["direction"], value: number | null): string {
    if (!direction || value === null || !Number.isFinite(value)) {
        return "--";
    }
    const comparator = direction === "long" ? "<" : ">";
    return `${comparator}${formatPrice(value)}`;
}

function formatPrice(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    if (Math.abs(value) >= 100) {
        return value.toFixed(2);
    }
    if (Math.abs(value) >= 1) {
        return value.toFixed(4);
    }
    return value.toPrecision(4);
}

function formatRatio(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
        return "--";
    }
    if (!Number.isFinite(value)) {
        return "Inf";
    }
    return value.toFixed(value >= 10 ? 1 : 2);
}

function formatPairContributionWarning(entry: BatchSyntheticPairContribution): string {
    return `${entry.symbol}:${entry.label}`
        + `(n=${entry.oosCountWithout}, ret=${formatSignedPercent(entry.oosReturnWithoutPct)}, delta=${formatSignedPercent(entry.returnDeltaPct)})`;
}

function getMinerVerdictClass(verdict: BatchSyntheticAssetVerdict["verdict"]): string {
    switch (verdict) {
        case "LONG":
        case "SHORT":
            return "finder-verdict-strong";
        case "WATCH":
            return "finder-verdict-marginal";
        case "SKIP":
            return "finder-verdict-losing";
        case "INCONCLUSIVE":
        default:
            return "finder-verdict-thin";
    }
}

function getStabilityActionClass(action: ReturnType<typeof computeStabilityAction>["action"]): string {
    switch (action) {
        case "ENTER":
            return "finder-verdict-strong";
        case "WATCH":
            return "finder-verdict-marginal";
        case "WAIT":
            return "finder-verdict-thin";
        case "INVALID":
            return "finder-verdict-thin";
        case "REJECT":
        default:
            return "finder-verdict-losing";
    }
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatNumber(value: number | null | undefined, digits: number): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return value.toFixed(digits);
}

function formatSignedPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

export const batchBacktestService = new BatchBacktestService();
