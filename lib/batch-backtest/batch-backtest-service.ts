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
import { ensureLazyStylesheet } from "../lazy-styles";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { isDirectFractionTradeSizingMode, usesFixedDollarSizing } from "../types/backtest";
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";
import { copyToClipboard } from "../browser-transfer";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import {
    readBatchAutoRunStability,
    shouldAutoRunBatchStability,
    writeBatchAutoRunStability,
} from "./batch-auto-stability-preference";
import { getBatchDatasetCacheStats } from "./batch-backtest-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { buildBatchRunFingerprint, parseBatchSymbols, BATCH_MAX_SYMBOLS } from "./batch-run-contract";
import { BATCH_SYMBOL_TEMPLATES, type BatchSymbolTemplateKey } from "./batch-symbol-templates";
import {
    formatBatchOverallSummary,
    buildBatchSummaryCells,
    buildResultRowGrid,
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
    BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
    type BatchSyntheticAssetVerdict,
    type BatchSyntheticMinerResult,
    type BatchSyntheticPairContribution,
} from "./batch-synthetic-state-miner";
import {
    type BatchStabilityMineResult,
    type BatchStabilityRow,
} from "./batch-stability-mine";
import { formatPortfolioFitSummary, shortFingerprint } from "./batch-portfolio-fit-summary";
import type {
    BatchPortfolioFitInput,
    BatchPortfolioFitResult,
} from "./batch-portfolio-fit-types";
import type { BatchPortfolioFitStreamEvent } from "./batch-backtest-stream-types";
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
    type StabilityActionDecision,
} from "./miner-verdict-format-helpers";
import {
    isStabilityTargetSuppressed,
    pickStabilityTopTrade,
    projectStabilityTarget,
    stabilityHorizonBars,
    type StabilityTopPick,
} from "./stability-top-pick";
import type { StrategyParams, BacktestSettings } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";

const BATCH_RESULTS_STORAGE = {
    key: "playground_batch_backtest_latest_results",
    schema: "batch_backtest.latest_results",
    version: 1,
} as const;

/**
 * Max rows buffered before a synchronous mid-stream flush (Finding 6). The
 * live stream queues DOM renders and flushes once per animation frame, but a
 * very fast cached run could queue hundreds of rows before the first frame;
 * this cap forces a flush so visible progress never lags too far behind the
 * streamed count. Terminal paths always flush regardless of queue size.
 */
const LIVE_RENDER_MAX_BATCH = 50;

class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: BatchBacktestSymbolResult[] = [];
    private lastMinerResult: BatchSyntheticMinerResult | null = null;
    private lastStabilityResult: BatchStabilityMineResult | null = null;
    private lastPortfolioFitResult: BatchPortfolioFitResult | null = null;
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
    // Serializes Mine Timing, Stability, and Portfolio Fit.
    private analysisInFlight = false;
    // Set when Stop races analysis preflight or POST establishment.
    private analysisCancelRequested = false;
    // /stop is not operation-scoped, so new work must wait for every request.
    private pendingStopPromise: Promise<void> | null = null;
    // True when the most recent server-side Run finished with artifacts still
    // on the server (the Mine Timing button is enabled on this flag, NOT on
    // `row.data !== undefined`, because in server-side mode the browser never
    // holds `row.data`).
    private serverHasArtifacts = false;
    // Live-stream DOM render queue (Finding 6). The server stream emits one
    // `symbol` event per row; appending each to the DOM synchronously caused
    // one reflow per row (up to ~1000 on a large cached run). Rows are pushed
    // to `lastResults` immediately (data stays current) but their DOM nodes
    // are queued here and flushed once per animation frame (or when the batch
    // hits LIVE_RENDER_MAX_BATCH, to keep very fast streams from deferring
    // visible progress too long). Terminal paths flush synchronously so the
    // final row count is always visible immediately on done/cancel/error.
    private liveRenderQueue: BatchBacktestSymbolResult[] = [];
    private liveRenderRafId: number | null = null;
    // Reattach polling timer id (set when this tab is observing a server-side
    // run that started before page load).
    private reattachTimer: ReturnType<typeof setTimeout> | null = null;
    private reattachTimerResolve: (() => void) | null = null;
    private reattachPollingStopped = false;
    // Consecutive failed status polls during a reattach (audit Finding 4).
    // Reset to 0 on any successful response. A transient Vite restart or
    // network hiccup no longer strands the tab with stale buttons: the loop
    // retries with capped backoff until either a response lands or the
    // generous MAX_REATTACH_CONSECUTIVE_FAILURES threshold is reached.
    private reattachConsecutiveFailures = 0;
    // Benchmark snapshot for the Copy Benchmark button. Each phase (run/mine/
    // stability) records wall clock + cache stats on completion; missing phases
    // stay null. `null` until at least one phase has completed in this session.
    private lastBenchmark: BatchBenchmarkSnapshot | null = null;
    private pendingServerRunCacheStats: BatchBenchmarkCacheStats | null = null;

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    public init(): void {
        ensureLazyStylesheet("batch-backtest-styles", new URL("../../styles/batch-backtest.css", import.meta.url).href);
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        dom.batchBacktestAutoRunStability.checked = readBatchAutoRunStability();
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
            // The same button also stops normal Batch runs.
            if (this.analysisInFlight) {
                this.analysisCancelRequested = true;
            }
            this.requestServerStop();
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
        dom.batchBacktestAutoRunStability.addEventListener("change", () => {
            writeBatchAutoRunStability(dom.batchBacktestAutoRunStability.checked);
        });
        dom.batchBacktestCopyStabilityBtn.addEventListener("click", () => {
            void this.copyStabilityResults();
        });
        dom.batchBacktestPortfolioFitBtn.addEventListener("click", () => {
            void this.runPortfolioFit();
        });
        dom.batchBacktestCopyPortfolioFitBtn.addEventListener("click", () => {
            void this.copyPortfolioFitResults();
        });
        dom.batchBacktestSymbolTemplate.addEventListener("change", () => {
            const key = dom.batchBacktestSymbolTemplate.value as BatchSymbolTemplateKey;
            const template = BATCH_SYMBOL_TEMPLATES[key];
            if (!template) return;
            dom.batchBacktestSymbols.value = template;
            dom.batchBacktestSymbolTemplate.value = "";
            this.clearStaleResults(dom);
            this.updateSummary(dom);
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
        if (symbols.length > BATCH_MAX_SYMBOLS) {
            dom.batchBacktestStatus.textContent =
                `Batch size ${symbols.length} exceeds the ${BATCH_MAX_SYMBOLS}-symbol limit. Split into chunks of ${BATCH_MAX_SYMBOLS} or fewer.`;
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
        // Finding 6: a previous run's pending live-render RAF must not fire
        // against this new run's freshly-cleared results list.
        this.cancelLiveRenderRaf();
        this.liveRenderQueue = [];
        this.cancelled = false;
        this.analysisCancelRequested = false;
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
        this.setRunBusy(dom, true);
        this.clearMinerResults(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        // Batch has one execution path: the Vite dev server streams scalar
        // rows while retaining heavy Mine artifacts outside the browser tab.
        // Reset the prior run's server cache stats so they can't leak into the
        // next run's benchmark if the `done` event never arrives (cancel /
        // crash). `recordRunBenchmark` re-populates this from the `done` event
        // or the recovery/reattach path.
        this.pendingServerRunCacheStats = null;
        const runStartedAt = performance.now();
        try {
            await this.runBatchServer(dom, token, symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint);
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
                dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
                dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
                this.setRunBusy(dom, false);
                this.recordRunBenchmark("server", strategyKey, interval, runStartedAt);
                const hasMineableArtifacts = this.serverHasArtifacts;
                if (shouldAutoRunBatchStability(
                    dom.batchBacktestAutoRunStability.checked,
                    this.cancelled,
                    hasMineableArtifacts,
                )) {
                    await this.runStabilityMine();
                }
            }
        }
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
        // Malformed lines also fail instead of silently dropping events.
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
                    // Finding 6: push to lastResults immediately (data stays
                    // current for Copy/Stop) but queue the DOM render and
                    // flush once per animation frame to avoid one reflow per
                    // row on large cached runs.
                    this.lastResults.push(event.row);
                    this.appendedCount += 1;
                    this.queueLiveRender(dom, event.row, token);
                },
                onDone: (event: Extract<BatchStreamEvent, { type: "done" }>) => {
                    if (token !== this.runToken) return;
                    // Finding 6: drain any queued live renders synchronously so
                    // the final row count is visible immediately on done.
                    this.cancelLiveRenderRaf();
                    this.flushLiveRenderNow(dom, token);
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
        // Finding 6: drain any queued live renders before the token check /
        // recovery path. If the stream threw mid-flight, `onDone` never fired
        // and queued rows would otherwise be lost or double-appended when
        // recovery rebuilds the DOM. Cancel the pending RAF first so it can't
        // fire after this synchronous drain.
        this.cancelLiveRenderRaf();
        if (token === this.runToken) {
            this.flushLiveRenderNow(dom, token);
        } else {
            this.liveRenderQueue = [];
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
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.getDom();
        try {
            if (!this.serverHasArtifacts) {
                dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
                return;
            }
            if (!this.lastRunFingerprint) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
                dom.batchBacktestCopyMinerBtn.disabled = true;
                return;
            }
            if (this.analysisCancelRequested) return;
            this.beginAnalysisBusy(dom);
            dom.batchBacktestMineBtn.disabled = true;
            dom.batchBacktestCopyMinerBtn.disabled = true;
            dom.batchBacktestMinerSummary.textContent = "Mining on server...";
            dom.batchBacktestMinerResults.replaceChildren();
            const mineStartedAt = performance.now();
            const targetCount = await this.runMinerServer(dom);
            this.recordMineBenchmark(mineStartedAt, targetCount);
        } finally {
            await this.finishAnalysisBusy(dom);
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
            await this.reissueStopIfNeeded();
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
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
            this.updatePortfolioFitButtonState(dom);
        }
        return targetCount;
    }

    /** Cancel the Batch run and any analysis holding the server miner lock. */
    private async stopServerWork(): Promise<void> {
        try {
            await fetch("/api/batch-backtest/stop", { method: "POST" });
        } catch (error) {
            debugLogger.warn("batch.server.stop_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Do not coalesce Stops: the first may arrive before analysis ownership.
    private requestServerStop(): Promise<void> {
        const request = this.stopServerWork();
        const prior = this.pendingStopPromise;
        const pending = prior
            ? Promise.all([prior, request]).then(() => undefined)
            : request;
        this.pendingStopPromise = pending;
        void pending.finally(() => {
            if (this.pendingStopPromise === pending) {
                this.pendingStopPromise = null;
            }
        });
        return request;
    }

    // Fetch resolves after the route owns the miner lock, so a second Stop sent
    // here closes the pre-ownership race.
    private async reissueStopIfNeeded(): Promise<void> {
        if (!this.analysisCancelRequested) return;
        this.analysisCancelRequested = false;
        await this.requestServerStop();
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
     *
     * Transient failure recovery (audit Finding 4): a thrown fetch or JSON
     * parse no longer abandons the run. Each poll's fetch+parse is wrapped so a
     * failure increments `reattachConsecutiveFailures`, surfaces a
     * "connection interrupted" status alongside the last known snapshot, and
     * retries with capped backoff (2s → 5s → 10s → 15s). A successful poll
     * resets the counter. Only after `MAX_REATTACH_CONSECUTIVE_FAILURES`
     * (~5 min at the 15s ceiling) does the loop give up and restore the Run
     * button so the user can re-click to reattach — turning a single Vite
     * restart from a fatal UI failure into a recoverable delay.
     */
    private async reattachToInProgressServerRun(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        const LONG_POLL_INTERVAL_MS = 5000;
        const FAST_POLL_COUNT = 150; // 5 minutes at 2s before stepping down to 5s.
        // Capped backoff for transient status-poll failures (audit Finding 4).
        const FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;
        // After this many consecutive failures, stop retrying and surface the
        // "click Run to reattach" state. ~5 min at the 15s ceiling (20 × 15s)
        // — comfortably longer than a Vite dev-server restart.
        const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;
        this.reattachPollingStopped = false;
        this.reattachConsecutiveFailures = 0;
        // Last snapshot rendered while the run was healthy, so the
        // "connection interrupted" branch can keep the last known progress
        // visible instead of blanking the status line.
        let lastRunLabel: string | null = null;
        try {
            for (let poll = 0; ; poll += 1) {
                if (this.reattachPollingStopped) {
                    // stopReattachPoll() ran between iterations (Stop / dispose / new Run).
                    return;
                }
                let payload: {
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
                try {
                    const response = await fetch(`/api/batch-backtest/status?after=${this.lastResults.length}`, { cache: "no-store" });
                    // Audit Finding 4: a non-2xx status is a transient failure,
                    // not a parseable payload — treat it the same as a thrown
                    // fetch so the backoff path engages instead of crashing on
                    // `await response.json()` of an error body.
                    if (!response.ok) {
                        throw new Error(`status ${response.status}`);
                    }
                    payload = await response.json() as typeof payload;
                } catch (error) {
                    if (this.reattachPollingStopped) return;
                    this.reattachConsecutiveFailures += 1;
                    debugLogger.warn("batch.server.reattach_poll_failed", {
                        consecutive: this.reattachConsecutiveFailures,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    if (this.reattachConsecutiveFailures > MAX_REATTACH_CONSECUTIVE_FAILURES) {
                        // Give up retrying but do NOT strand the UI: restore the
                        // Run button so the tab isn't stuck on stale busy state.
                        // The server may still own the run or have finished it
                        // with retained artifacts; reloading the page re-runs
                        // init()'s reattach, which picks up either outcome.
                        // Mirrors the normal-completion DOM restore below.
                        const dom = this.getDom();
                        dom.batchBacktestRunBtn.disabled = false;
                        setVisible(dom.batchBacktestStopBtn, false);
                        this.setRunBusy(dom, false);
                        this.updateSummary(dom);
                        dom.batchBacktestStatus.textContent = "Server connection lost — reload to reattach, or click Run to start over.";
                        return;
                    }
                    // Keep the last known progress visible alongside the
                    // interrupted warning so the user can see the run is
                    // (probably) still alive on the server.
                    const prior = lastRunLabel ? ` (${lastRunLabel})` : "";
                    this.getDom().batchBacktestStatus.textContent
                        = `Server connection interrupted${prior} — retrying (${this.reattachConsecutiveFailures}/${MAX_REATTACH_CONSECUTIVE_FAILURES})`;
                    const backoffIndex = Math.min(this.reattachConsecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
                    const backoffDelay = FAILURE_BACKOFF_MS[backoffIndex]!;
                    await new Promise<void>((resolve) => {
                        this.reattachTimerResolve = resolve;
                        this.reattachTimer = setTimeout(resolve, backoffDelay);
                    });
                    this.reattachTimer = null;
                    this.reattachTimerResolve = null;
                    // Don't advance `poll` into the long-poll step-down just
                    // because of retries — backoff already shed load.
                    poll -= 1;
                    continue;
                }
                // Successful poll: reset the transient-failure counter.
                this.reattachConsecutiveFailures = 0;
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
                        this.updatePortfolioFitButtonState(this.getDom());
                    }
                    if (this.lastResults.length > 0) {
                        this.saveLatestResultsSnapshot();
                    }
                    // Only restore Run/Stop/busy if reattach is still the active
                    // task. A user clicking Run while this fetch was in-flight
                    // calls stopReattachPoll(); in that case the user's Run owns
                    // the button/busy state now and we must not clobber it
                    // (re-reenabling Run / hiding Stop / clearing is-running
                    // mid-run). The loop-top check at line start does not cover
                    // the await above, so guard the DOM writes explicitly.
                    if (!this.reattachPollingStopped) {
                        const dom = this.getDom();
                        dom.batchBacktestRunBtn.disabled = false;
                        setVisible(dom.batchBacktestStopBtn, false);
                        this.setRunBusy(dom, false);
                        this.updateSummary(dom);
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
                this.setRunBusy(dom, true);
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
                const label = `Server run ${seen}/${run.total}${current}`;
                dom.batchBacktestStatus.textContent = label;
                // Capture for the transient-failure branch so the
                // "connection interrupted" message can keep the last known
                // progress visible (audit Finding 4).
                lastRunLabel = label;
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
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.getDom();
        try {
            if (!this.serverHasArtifacts || !this.lastRunFingerprint) {
                dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
                return;
            }
            const currentFingerprint = this.buildCurrentRunFingerprint();
            if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before stability mining; settings or symbols changed.";
                dom.batchBacktestCopyStabilityBtn.disabled = true;
                return;
            }
            this.beginAnalysisBusy(dom);
            const hasServerArtifacts = await this.refreshServerArtifactState(currentFingerprint);
            if (this.analysisCancelRequested) return;
            if (!hasServerArtifacts) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before stability mining; no artifacts on server.";
                dom.batchBacktestStabilityMineBtn.disabled = true;
                return;
            }
            const stabilityStartedAt = performance.now();
            await this.runStabilityMineServer(dom);
            this.recordStabilityBenchmark(stabilityStartedAt);
        } finally {
            await this.finishAnalysisBusy(dom);
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
        this.lastPortfolioFitResult = null;
        dom.batchBacktestCopyPortfolioFitBtn.disabled = true;
        dom.batchBacktestPortfolioFitSummary.textContent = "";
        dom.batchBacktestPortfolioFitResults.replaceChildren();

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
            await this.reissueStopIfNeeded();
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
            }, { requireTerminal: true });
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
            this.updatePortfolioFitButtonState(dom);
            this.serverHasArtifacts = true;
            this.saveLatestResultsSnapshot();
            this.persistMineTimingResult("stability");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastStabilityResult = null;
            dom.batchBacktestMinerSummary.textContent = `Stability miner error: ${message}`;
            debugLogger.error("batch_stability_miner.server_failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
            this.updatePortfolioFitButtonState(dom);
        }
    }

    private async refreshServerArtifactState(expectedFingerprint: string): Promise<boolean> {
        const previouslyAvailable = this.serverHasArtifacts;
        try {
            const response = await fetch("/api/batch-backtest/status", { cache: "no-store" });
            if (!response.ok) {
                debugLogger.warn("batch.server.artifact_status_failed", { status: response.status });
                return previouslyAvailable;
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
            debugLogger.warn("batch.server.artifact_status_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return previouslyAvailable;
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

    // -----------------------------------------------------------------------
    // Portfolio Fit (R16: does not release artifacts; runs after Stability)
    // -----------------------------------------------------------------------

    private async runPortfolioFit(): Promise<void> {
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.getDom();
        try {
            if (!this.lastStabilityResult || this.lastStabilityResult.rows.length === 0) {
                dom.batchBacktestPortfolioFitSummary.textContent = "Run Stability Mine before Portfolio Fit.";
                return;
            }
            const currentFingerprint = this.buildCurrentRunFingerprint();
            if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
                dom.batchBacktestPortfolioFitSummary.textContent = "Rerun Batch before Portfolio Fit; settings or symbols changed.";
                return;
            }
            this.beginAnalysisBusy(dom);
            const hasServerArtifacts = await this.refreshServerArtifactState(currentFingerprint);
            if (this.analysisCancelRequested) return;
            if (!hasServerArtifacts) {
                dom.batchBacktestPortfolioFitSummary.textContent = "Rerun Batch before Portfolio Fit; no artifacts on server.";
                dom.batchBacktestPortfolioFitBtn.disabled = true;
                return;
            }
            await this.runPortfolioFitServer(dom);
        } finally {
            await this.finishAnalysisBusy(dom);
        }
    }

    private async runPortfolioFitServer(dom: BatchBacktestDom): Promise<void> {
        dom.batchBacktestPortfolioFitBtn.disabled = true;
        dom.batchBacktestCopyPortfolioFitBtn.disabled = true;
        dom.batchBacktestPortfolioFitSummary.textContent = "Running Portfolio Fit on server...";
        this.lastPortfolioFitResult = null;
        try {
            const capital = this.resolvePortfolioFitCapital();
            // Stability context is retained and resolved by the server.
            const response = await fetch("/api/batch-backtest/portfolio-fit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval ?? state.currentInterval,
                    capital,
                }),
            });
            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => "");
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore */ }
                if (response.status === 400 && payload.error?.includes("no artifacts")) {
                    this.serverHasArtifacts = false;
                }
                throw new Error(payload.error ?? (text || `HTTP ${response.status}`));
            }
            await this.reissueStopIfNeeded();
            const received: { result: BatchPortfolioFitResult | null; cancelledSummary: string | null } = {
                result: null,
                cancelledSummary: null,
            };
            await consumeNdjsonStream<BatchPortfolioFitStreamEvent>(response.body, {
                onStart: () => {
                    dom.batchBacktestPortfolioFitSummary.textContent = "Portfolio Fit running on server...";
                },
                onProgress: (event: Extract<BatchPortfolioFitStreamEvent, { type: "progress" }>) => {
                    dom.batchBacktestPortfolioFitSummary.textContent = `Portfolio Fit ${event.percent}% - ${event.text}`;
                },
                onDone: (event: Extract<BatchPortfolioFitStreamEvent, { type: "done" }>) => {
                    if (event.ok) {
                        received.result = event.result;
                    } else {
                        received.cancelledSummary = event.summary;
                    }
                },
                onFatal: (event: Extract<BatchPortfolioFitStreamEvent, { type: "fatal" }>) => {
                    throw new Error(event.error);
                },
            }, { requireTerminal: true });
            if (received.cancelledSummary) {
                this.lastPortfolioFitResult = null;
                dom.batchBacktestPortfolioFitSummary.textContent = received.cancelledSummary;
                return;
            }
            if (!received.result) {
                throw new Error("Server Portfolio Fit did not return a result.");
            }
            this.lastPortfolioFitResult = received.result;
            this.renderPortfolioFitResult(dom, received.result);
            dom.batchBacktestCopyPortfolioFitBtn.disabled = false;
            this.serverHasArtifacts = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastPortfolioFitResult = null;
            dom.batchBacktestPortfolioFitSummary.textContent = `Portfolio Fit error: ${message}`;
            debugLogger.error("batch_portfolio_fit.server_failed", { error: message });
        } finally {
            this.updatePortfolioFitButtonState(dom);
        }
    }

    private resolvePortfolioFitCapital(): BatchPortfolioFitInput["capital"] {
        const cs = backtestService.getCapitalSettings();
        const initialCapital = cs.initialCapital > 0 ? cs.initialCapital : 10000;
        // R6/R11: resolve the base allocation mirroring position-builder.ts:246.
        // The engine's resolved Kelly/optimal-f fraction is NOT available at
        // post-analysis time (rolling SmartSizingState is not persisted), so
        // `kellyFraction` stays null and we record the fallback provenance.
        const isDirectFraction = isDirectFractionTradeSizingMode(cs.sizingMode);
        const usePercentBase = (cs.sizingMode === "martingale" || cs.sizingMode === "anti_martingale")
            && cs.advancedSizing?.martingaleBaseSize === "percent";
        const preferFixedFallback = isDirectFraction && cs.fixedTradeAmount > 0;
        const usesFixedDollar = !usePercentBase
            && (usesFixedDollarSizing(cs.sizingMode) || preferFixedFallback)
            && cs.fixedTradeAmount > 0;

        let baseAllocation: number;
        let baseAllocationSource: BatchPortfolioFitInput["capital"]["baseAllocationSource"];
        if (usesFixedDollar && cs.fixedTradeAmount > 0) {
            baseAllocation = cs.fixedTradeAmount;
            baseAllocationSource = isDirectFraction
                ? "direct_fraction_fallback_fixed"
                : "fixed";
        } else {
            baseAllocation = initialCapital * (cs.positionSize / 100);
            baseAllocationSource = isDirectFraction
                ? "direct_fraction_fallback_percent"
                : "percent";
        }

        // configuredKellyFraction: surface the user's configured fraction for
        // transparency when Kelly sizing is active. kellyFraction stays null
        // because the fraction was NOT applied to resolve baseAllocation
        // (baseAllocationSource would need to be "resolved_kelly" for that).
        const configuredKellyFraction: BatchPortfolioFitInput["capital"]["configuredKellyFraction"]
            = cs.sizingMode === "kelly_criterion"
                ? (cs.advancedSizing?.kellyFraction ?? "half")
                : null;

        return {
            initialCapital,
            baseAllocation,
            kellyFraction: null, // never resolved at post-analysis in v1
            baseAllocationSource,
            configuredKellyFraction,
        };
    }

    private renderPortfolioFitResult(dom: BatchBacktestDom, result: BatchPortfolioFitResult): void {
        const label = "Portfolio Fit (EXPERIMENTAL - independent validation unavailable)";
        const accepted = result.rows.filter((r) => r.decision === "ADD" || r.decision === "ADD_SMALL").length;
        dom.batchBacktestPortfolioFitSummary.textContent =
            `${label} | ${accepted}/${result.rows.length} accepted | allocated ${(result.portfolio.allocatedFraction * 100).toFixed(1)}%`
            + ` | sizing: ${result.baseAllocationSource}`
            + (result.configuredKellyFraction !== null ? ` | Kelly configured: ${result.configuredKellyFraction}` : "")
            + (result.kellyFraction === null && result.configuredKellyFraction !== null ? " | Kelly resolved: unavailable" : "");
        const container = dom.batchBacktestPortfolioFitResults;
        container.replaceChildren();
        if (result.rows.length === 0) {
            container.textContent = "No candidates.";
            return;
        }
        for (const row of result.rows) {
            const el = document.createElement("div");
            el.className = "batch-miner-row";
            const reasons = row.reasonCodes.join(", ");
            const allocationLimit = row.allocationLimitReasonCodes.length > 0
                ? ` | limited by ${row.allocationLimitReasonCodes.join(", ")}`
                : "";
            el.textContent = `${row.asset} ${row.direction} -> ${row.decision} | ${(row.allocationFraction * 100).toFixed(1)}% | ${reasons}${allocationLimit}`;
            container.appendChild(el);
        }
    }

    private async copyPortfolioFitResults(): Promise<void> {
        if (!this.lastPortfolioFitResult) return;
        const text = formatPortfolioFitSummary(this.lastPortfolioFitResult).join("\n");
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.getDom().batchBacktestPortfolioFitSummary.textContent = "Copy Portfolio Fit failed.";
        }
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
        this.lastPortfolioFitResult = null;
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
        dom.batchBacktestPortfolioFitBtn.disabled = true;
        dom.batchBacktestCopyPortfolioFitBtn.disabled = true;
        if (this.lastStabilityResult) {
            this.renderStabilityResult(dom, this.lastStabilityResult);
            dom.batchBacktestCopyStabilityBtn.disabled = this.lastStabilityResult.rows.length === 0;
        }
        if (this.lastPortfolioFitResult) {
            // Mark as non-current: artifacts/fingerprint may have expired.
            this.renderPortfolioFitResult(dom, this.lastPortfolioFitResult);
            dom.batchBacktestCopyPortfolioFitBtn.disabled = false;
            dom.batchBacktestPortfolioFitSummary.textContent += " (restored — rerun Batch to confirm current)";
        }
        dom.batchBacktestStatus.textContent = `Restored last Batch run (${this.lastResults.length} pairs)`;
        this.setProgress(dom, 100, "Restored");
        this.renderSummaryGrid(dom);
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

    /**
     * Portfolio Fit is actionable only after Stability Mine produces actionable
     * rows AND artifacts are still available (server or browser-held). Mirrors
     * the Stability Mine button gate so the two stay in sync.
     */
    private canRunPortfolioFit(): boolean {
        return Boolean(this.lastStabilityResult && this.lastStabilityResult.rows.length > 0)
            && this.serverHasArtifacts;
    }

    private updatePortfolioFitButtonState(dom: BatchBacktestDom): void {
        dom.batchBacktestPortfolioFitBtn.disabled = !this.canRunPortfolioFit();
    }

    private clearMinerResults(dom: BatchBacktestDom): void {
        this.lastMinerResult = null;
        this.lastStabilityResult = null;
        this.lastPortfolioFitResult = null;
        // Clear rather than show "Miner idle": an empty .batch-miner-status
        // collapses via CSS (:empty) so the run-state region does not show a
        // noise strip before any mining has happened (point 7 of the refactor).
        dom.batchBacktestMinerSummary.textContent = "";
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestPortfolioFitBtn.disabled = true;
        dom.batchBacktestCopyPortfolioFitBtn.disabled = true;
        dom.batchBacktestPortfolioFitSummary.textContent = "";
        dom.batchBacktestPortfolioFitResults.replaceChildren();
    }

    private createMinerRow(verdict: BatchSyntheticAssetVerdict): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "batch-miner-row";
        const evidence = verdict.evidence;
        const direction = verdict.direction ? verdict.direction.toUpperCase() : "--";
        const mfeMaeRatio = computeMinerMfeMaeRatio(evidence.expectedMfePct, evidence.expectedMaePct);
        const targetPrice = computeMinerTargetPrice(verdict);
        const invalidationPrice = computeMinerInvalidationPrice(verdict);

        // Primary: verdict + asset + direction + age/confidence.
        const primary = document.createElement("div");
        primary.className = "batch-miner-primary";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${getMinerVerdictClass(verdict.verdict)}`;
        badge.textContent = verdict.verdict;
        const asset = document.createElement("span");
        asset.className = "batch-miner-asset";
        asset.textContent = verdict.asset;
        const dir = document.createElement("span");
        dir.className = "batch-miner-direction";
        dir.textContent = direction;
        primary.appendChild(badge);
        primary.appendChild(asset);
        primary.appendChild(dir);
        primary.appendChild(this.createMinerMetric("Age", computeMinerAgeTag(verdict)));
        primary.appendChild(this.createMinerMetric("Conf", verdict.confidence));
        primary.appendChild(this.createMinerMetric(
            "Lift",
            formatSignedPercent(evidence.oosLiftPct),
            evidence.oosLiftPct,
        ));
        primary.appendChild(this.createMinerMetric(
            "RR",
            formatRatio(mfeMaeRatio),
        ));
        primary.appendChild(this.createMinerMetric(
            "Ret",
            formatSignedPercent(evidence.expectedForwardReturnPct),
            evidence.expectedForwardReturnPct,
        ));
        primary.appendChild(this.createMinerMetric(
            "Analogs",
            `${evidence.analogCount}/${evidence.candidateCount}`,
        ));
        line.appendChild(primary);

        // Secondary: edge diagnostics (distance, target/invalidation, horizons).
        const metrics = document.createElement("div");
        metrics.className = "batch-miner-metrics";
        const horizonLabel = evidence.horizonBarsAll.length > 1
            ? `[${evidence.horizonBarsAll.join(",")}]`
            : `${evidence.horizonBars}`;
        metrics.appendChild(this.createMinerMetric("Hrz", horizonLabel));
        metrics.appendChild(this.createMinerMetric("Dist", formatNumber(evidence.avgDistance, 2)));
        metrics.appendChild(this.createMinerMetric(
            "Entry",
            formatPrice(verdict.currentSnapshot?.close ?? null),
        ));
        metrics.appendChild(this.createMinerMetric(
            "Target",
            formatTargetPrice(verdict.direction, targetPrice, evidence.longestHorizonBars, formatPrice),
        ));
        metrics.appendChild(this.createMinerMetric(
            "Inv",
            formatInvalidationPrice(verdict.direction, invalidationPrice),
        ));
        if (evidence.oosCount > 0) {
            metrics.appendChild(this.createMinerMetric("OOS", `${evidence.oosCount}`));
        }
        line.appendChild(metrics);

        // Disclosure: the first reason (the "why" behind the verdict).
        const reason = verdict.reasons[0];
        if (reason) {
            const reasonEl = document.createElement("div");
            reasonEl.className = "batch-miner-reason";
            reasonEl.textContent = reason;
            line.appendChild(reasonEl);
        }
        return line;
    }

    private createMinerMetric(
        label: string,
        value: string,
        signedValue?: number | null,
    ): HTMLSpanElement {
        const wrap = document.createElement("span");
        wrap.className = "batch-miner-metric";
        const labelEl = document.createElement("span");
        labelEl.className = "batch-miner-metric-label";
        labelEl.textContent = label;
        const valueEl = document.createElement("span");
        let cls = "batch-miner-metric-value";
        if (signedValue !== null && signedValue !== undefined && Number.isFinite(signedValue)) {
            if (signedValue > 0) cls += " is-profit";
            else if (signedValue < 0) cls += " is-loss";
        }
        valueEl.className = cls;
        valueEl.textContent = value;
        wrap.appendChild(labelEl);
        wrap.appendChild(valueEl);
        return wrap;
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
        const decisions = result.rows.map((row) => computeStabilityAction(row, result.reruns, interval));
        const fragment = document.createDocumentFragment();
        const topPick = pickStabilityTopTrade(result.rows, decisions);
        let skipKey: string | null = null;
        if (topPick !== null) {
            // Reuse the same row renderer so the callout's metrics match the
            // list below — the only difference is the modifier classes. The
            // picked row is then skipped in the list loop so it isn't shown
            // twice (callout + sorted position).
            const topRow = this.createStabilityRow(topPick.row, topPick.decision, result.reruns);
            topRow.classList.add("batch-miner-top-pick");
            // WATCH and WEAK are mutually exclusive classes: a WATCH pick is
            // always conviction=WEAK, but "WATCH (not yet actionable)" is the
            // more specific signal — don't let the WEAK label override it.
            if (topPick.tier === "WATCH") topRow.classList.add("is-watch");
            else if (topPick.conviction === "WEAK") topRow.classList.add("is-weak");
            skipKey = `${topPick.row.asset}|${topPick.row.direction}`;
            fragment.appendChild(topRow);
        }
        for (let i = 0; i < result.rows.length; i += 1) {
            const row = result.rows[i]!;
            if (skipKey !== null && `${row.asset}|${row.direction}` === skipKey) continue;
            fragment.appendChild(this.createStabilityRow(row, decisions[i]!, result.reruns));
        }
        dom.batchBacktestMinerResults.appendChild(fragment);
    }

    /**
     * Two-level Stability row (point 6 of the Batch UI refactor). Primary line
     * carries the decision surface (asset, direction, action, score, hit rate,
     * freshness); secondary line carries edge diagnostics; the row is flagged
     * stale when the underlying data lag invalidates the action. The pipe
     * formatter stays for clipboard / Copy Stability output.
     */
    private createStabilityRow(
        row: BatchStabilityRow,
        decision: StabilityActionDecision,
        reruns: number,
    ): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "batch-miner-row";
        const isStale = decision.action === "INVALID";
        if (isStale) line.classList.add("is-stale");

        // Primary: action + asset + direction + score + hit rate + freshness.
        const primary = document.createElement("div");
        primary.className = "batch-miner-primary";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${getStabilityActionClass(decision.action)}`;
        badge.textContent = decision.action;
        const asset = document.createElement("span");
        asset.className = "batch-miner-asset";
        asset.textContent = row.asset;
        const dir = document.createElement("span");
        dir.className = "batch-miner-direction";
        dir.textContent = row.direction;
        primary.appendChild(badge);
        primary.appendChild(asset);
        primary.appendChild(dir);
        primary.appendChild(this.createMinerMetric("Score", formatNumber(row.timingEdgeScore, 1)));
        primary.appendChild(this.createMinerMetric(
            "Hits",
            `${row.hits}/${reruns} (${formatPercent((row.hits / Math.max(1, reruns)) * 100)})`,
        ));
        primary.appendChild(this.createMinerMetric(
            "Fresh",
            `${Math.max(0, Math.floor(Number(row.freshHits) || 0))}/${row.hits}`,
        ));
        primary.appendChild(this.createMinerMetric("Gate", computeStabilityGate(row)));
        line.appendChild(primary);

        // Secondary: edge metrics + anchor concentration + age.
        const metrics = document.createElement("div");
        metrics.className = "batch-miner-metrics";
        metrics.appendChild(this.createMinerMetric("Ret", formatSignedPercent(row.medianRetPct), row.medianRetPct));
        metrics.appendChild(this.createMinerMetric("Lift", formatSignedPercent(row.medianLiftPct), row.medianLiftPct));
        metrics.appendChild(this.createMinerMetric("RR", formatRatio(row.medianRr)));
        metrics.appendChild(this.createMinerMetric(
            "Anchor",
            row.dominantPair ? `${row.dominantPair}:${(row.dominantPairShare * 100).toFixed(0)}%` : "--",
        ));
        metrics.appendChild(this.createMinerMetric(
            "Div",
            `${(row.medianDiversity * 100).toFixed(0)}%`,
        ));
        const barsHeld = row.medianBarsHeld === null || !Number.isFinite(row.medianBarsHeld)
            ? "--"
            : `${formatNumber(row.medianBarsHeld, 1)}b`;
        metrics.appendChild(this.createMinerMetric("Age", `${computeStabilityAgeTag(row)}:${barsHeld}`));
        const dataLag = decision.dataLagBars === null ? "--" : `${formatNumber(decision.dataLagBars, 1)}b`;
        metrics.appendChild(this.createMinerMetric("Lag", dataLag));
        metrics.appendChild(this.createMinerMetric("Px", formatPrice(row.close)));
        line.appendChild(metrics);

        // Disclosure: reason + H/M/L confidence counts + pair warnings.
        const diag = document.createElement("div");
        diag.className = "batch-miner-metrics";
        diag.appendChild(this.createMinerMetric("Why", decision.reason));
        diag.appendChild(this.createMinerMetric("H/M/L", `${row.high}/${row.medium}/${row.low}`));
        if (row.pairWarnings > 0) {
            diag.appendChild(this.createMinerMetric("PairWarn", `${row.pairWarnings}`));
        }
        line.appendChild(diag);
        return line;
    }

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    /**
     * Queue a live-stream row for DOM rendering and schedule a flush once per
     * animation frame (Finding 6). `lastResults` is already updated by the
     * caller, so this only defers the DOM mutation. A synchronous flush fires
     * when the queue hits LIVE_RENDER_MAX_BATCH so very fast cached streams
     * don't defer visible progress too long. Terminal paths call
     * `flushLiveRenderNow` to drain the queue synchronously.
     */
    private queueLiveRender(dom: BatchBacktestDom, result: BatchBacktestSymbolResult, token: number): void {
        this.liveRenderQueue.push(result);
        if (this.liveRenderQueue.length >= LIVE_RENDER_MAX_BATCH) {
            this.flushLiveRenderNow(dom, token);
            return;
        }
        if (this.liveRenderRafId !== null) return;
        this.liveRenderRafId = requestAnimationFrame(() => {
            this.liveRenderRafId = null;
            this.flushLiveRenderNow(dom, token);
        });
    }

    /**
     * Drain the live render queue through `appendResultRows` (one
     * DocumentFragment append). Guarded by the run token so a stale run that
     * lost ownership mid-stream doesn't write DOM after a newer run started.
     */
    private flushLiveRenderNow(dom: BatchBacktestDom, token: number): void {
        if (token !== this.runToken) {
            this.liveRenderQueue = [];
            return;
        }
        if (this.liveRenderQueue.length === 0) return;
        const batch = this.liveRenderQueue;
        this.liveRenderQueue = [];
        this.appendResultRows(dom, batch);
    }

    /**
     * Cancel any pending animation-frame flush and clear the queue. Called on
     * terminal paths (done/error/cancel) and when a run loses ownership, so a
     * stale RAF callback can't fire against a newer run's DOM.
     */
    private cancelLiveRenderRaf(): void {
        if (this.liveRenderRafId !== null) {
            cancelAnimationFrame(this.liveRenderRafId);
            this.liveRenderRafId = null;
        }
    }

    /**
     * Append many result rows in one DocumentFragment so restore / reattach
     * paths that render hundreds of rows synchronously do a single reflow
     * instead of one per row. Output is identical to calling appendResultRow
     * per element; this is purely a layout-cost optimization for bulk paths.
     * The live server stream is frame-batched separately via queueLiveRender
     * (one reflow per animation frame, not one per row).
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
        line.className = "batch-result-row";

        const verdict = computePerformanceVerdict(result.result, result.status);
        const grid = buildResultRowGrid(result);

        // Column 1: verdict badge + symbol + status.
        const identity = document.createElement("div");
        identity.className = "batch-result-identity";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${verdict.cssClass}`;
        badge.textContent = verdict.label;
        const symbol = document.createElement("span");
        symbol.className = "batch-result-symbol";
        symbol.textContent = grid.symbol;
        const status = document.createElement("span");
        status.className = "batch-result-status";
        status.textContent = grid.status;
        identity.appendChild(badge);
        identity.appendChild(symbol);
        identity.appendChild(status);
        line.appendChild(identity);

        // Columns 2-5: stable metric columns (Net+Exp / PF+Sharpe / DD / Trades).
        line.appendChild(this.createMetricCell("Net", grid.net.text, grid.net.sign));
        line.appendChild(this.createMetricCell("Exp", grid.expectancy.text, grid.expectancy.sign));
        line.appendChild(this.createMetricCell("PF", grid.profitFactor, "neutral", grid.sharpe, "Sharpe"));
        line.appendChild(this.createMetricCell("DD", grid.drawdown, "neutral", grid.trades, "Trades"));

        // Optional secondary metadata line: bars, hold, exposure, range.
        if (grid.secondary.length > 0) {
            const secondary = document.createElement("div");
            secondary.className = "batch-result-secondary";
            for (const [label, value] of grid.secondary) {
                const pair = document.createElement("span");
                pair.textContent = `${label} ${value}`;
                secondary.appendChild(pair);
            }
            line.appendChild(secondary);
        }

        if (grid.error) {
            const errorEl = document.createElement("div");
            errorEl.className = "batch-result-error";
            errorEl.textContent = grid.error;
            line.appendChild(errorEl);
        }
        return line;
    }

    /**
     * One metric column for a result row. Accepts an optional second value/label
     * so two tightly-related metrics (e.g. PF + Sharpe) share a column under a
     * combined label, keeping the grid to five columns.
     */
    private createMetricCell(
        label: string,
        value: string,
        sign: "profit" | "loss" | "neutral",
        secondValue?: string,
        secondLabel?: string,
    ): HTMLDivElement {
        const cell = document.createElement("div");
        cell.className = "batch-result-metric";
        const valueEl = document.createElement("span");
        valueEl.className = `batch-result-metric-value${sign === "profit" ? " is-profit" : sign === "loss" ? " is-loss" : ""}`;
        valueEl.textContent = secondValue ? `${value} / ${secondValue}` : value;
        const labelEl = document.createElement("span");
        labelEl.className = "batch-result-metric-label";
        labelEl.textContent = secondLabel ? `${label} / ${secondLabel}` : label;
        cell.appendChild(valueEl);
        cell.appendChild(labelEl);
        return cell;
    }

    // --------------------------------------------------------------------
    // Progress / summary helpers
    // --------------------------------------------------------------------

    private setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        dom.batchBacktestProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.batchBacktestProgressText.textContent = text;
    }

    /**
     * Toggle the tab root's `is-running` class. The progress bar is hidden by
     * default and only shown while this class is present (see
     * styles/batch-backtest.css). The generic `.progress-container.active` path
     * used by Finder is never toggled for the Batch tab, so without this class
     * hook the Batch progress bar would stay invisible for the entire run.
     */
    private setRunBusy(dom: BatchBacktestDom, busy: boolean): void {
        dom.batchbacktestTab.classList.toggle("is-running", busy);
    }

    private beginAnalysisBusy(dom: BatchBacktestDom): void {
        this.setRunBusy(dom, true);
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestPortfolioFitBtn.disabled = true;
    }

    // Keep operations disabled until unscoped /stop requests have settled.
    private async finishAnalysisBusy(dom: BatchBacktestDom): Promise<void> {
        this.analysisCancelRequested = false;
        this.setRunBusy(dom, false);
        setVisible(dom.batchBacktestStopBtn, false);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestPortfolioFitBtn.disabled = true;
        const pending = this.pendingStopPromise;
        if (pending) {
            try { await pending; } catch { /* stopServerWork swallows errors */ }
        }
        this.analysisInFlight = false;
        dom.batchBacktestRunBtn.disabled = false;
        dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
        dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
        this.updatePortfolioFitButtonState(dom);
    }

    private resetProgress(dom: BatchBacktestDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.batchBacktestStatus.textContent = "Idle";
        this.setRunBusy(dom, false);
    }

    private updateSummary(dom: BatchBacktestDom): void {
        if (this.lastResults.length > 0) {
            const count = this.lastResults.length;
            dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
            this.renderSummaryGrid(dom);
            return;
        }
        const count = parseBatchSymbols(dom.batchBacktestSymbols.value).length;
        dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
        dom.batchBacktestSummaryGrid.replaceChildren();
        dom.batchBacktestSummaryGrid.hidden = true;
    }

    /**
     * Render the completed-run summary as a compact metric grid (point 7 of the
     * Batch UI refactor): stable cells instead of a long pipe-delimited strip.
     * The full pipe summary stays the clipboard / Copy Results surface.
     */
    private renderSummaryGrid(dom: BatchBacktestDom): void {
        const cells = buildBatchSummaryCells(this.lastResults);
        if (cells === null) {
            dom.batchBacktestSummaryGrid.replaceChildren();
            dom.batchBacktestSummaryGrid.hidden = true;
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const [label, value] of cells) {
            const cell = document.createElement("div");
            cell.className = "batch-summary-cell";
            const labelEl = document.createElement("span");
            labelEl.className = "batch-summary-cell-label";
            labelEl.textContent = label;
            const valueEl = document.createElement("span");
            valueEl.className = "batch-summary-cell-value";
            valueEl.textContent = value;
            cell.appendChild(labelEl);
            cell.appendChild(valueEl);
            fragment.appendChild(cell);
        }
        dom.batchBacktestSummaryGrid.replaceChildren(fragment);
        dom.batchBacktestSummaryGrid.hidden = false;
    }

    private readClampedInt(raw: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(raw, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        return Math.max(min, Math.min(max, Math.floor(value)));
    }
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
    const decisions = result.rows.map((row) => computeStabilityAction(row, result.reruns, context.interval));
    const topPick = pickStabilityTopTrade(result.rows, decisions);
    if (topPick !== null) {
        lines.push(formatStabilityTopPickLine(topPick));
    }
    for (const row of result.rows) {
        lines.push(`STABILITY | ${formatStabilityRow(row, result.reruns, context.interval)}`);
    }
    return lines.join("\n");
}

/**
 * Single-line "best trade decision now" summary for the Copy Stability output.
 * Mirrors what the highlighted Top Pick callout shows in the DOM: asset,
 * direction, tier (ENTER vs a promoted WATCH), conviction, the decision
 * reason, the research score, current price, and a projected target with
 * horizon. The target is suppressed for stale analog states (the projection
 * extends a historical median from a state that fired ≥ 50 bars ago and would
 * overstate conviction — `>881.87@271b` on a 271-bar-stale row is not a level
 * to aim at).
 */
function formatStabilityTopPickLine(pick: StabilityTopPick): string {
    const { row, decision, tier, conviction } = pick;
    const targetSuppressed = isStabilityTargetSuppressed(row);
    const target = targetSuppressed ? null : projectStabilityTarget(row);
    const horizon = targetSuppressed ? null : stabilityHorizonBars(row);
    const targetText = targetSuppressed
        ? "-- (stale analog)"
        : formatTargetPrice(
            row.direction === "LONG" ? "long" : "short",
            target,
            horizon,
            formatPrice,
        );
    const tierLabel = tier === "ENTER"
        ? (conviction === "STRONG" ? "ENTER" : "ENTER · WEAK (stand-aside candidate)")
        : "WATCH (promoted, not yet actionable)";
    return [
        "STABILITY TOP PICK",
        row.asset,
        `Dir ${row.direction}`,
        `Tier ${tierLabel}`,
        `Action ${decision.action}`,
        `Why ${decision.reason}`,
        `Score ${formatNumber(row.timingEdgeScore, 1)}`,
        `Px ${formatPrice(row.close)}`,
        `Target ${targetText}`,
    ].join(" | ");
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
