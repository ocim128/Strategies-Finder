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
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { copyToClipboard } from "../browser-transfer";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import { getBatchDatasetCacheStats } from "./batch-backtest-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { extractBatchServerError, postBatchNdjson } from "./batch-ndjson-post";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { buildBatchRunFingerprint, parseBatchSymbols, BATCH_MAX_SYMBOLS } from "./batch-run-contract";
import { BALANCED_PAIR_LIST_MAX_PAIRS, generateBalancedPairList, type BalancedPairListResult, type PairListProvenanceV1 } from "./balanced-pair-list-generator";
import { fnv1a64Hex } from "./max-active-research-contract";
// Type-only import: the ~13KB BATCH_SYMBOL_TEMPLATES blob is loaded lazily in
// the dropdown `change` handler below so it stays out of the main app graph.
import type { BatchSymbolTemplateKey } from "./batch-symbol-templates";
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
    type BatchBenchmarkRunOutcome,
    type BatchBenchmarkRunPhase,
    type BatchBenchmarkSnapshot,
} from "./batch-benchmark-snapshot";
import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import type { BatchStreamEvent } from "./batch-backtest-stream-types";
import type { OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";
import type { OpenScoreUsdReplayStreamEvent } from "./batch-open-score-usd-replay-stream-types";
import type { StrategyParams, BacktestSettings } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { escapeHtml } from "../html-escape";

const BATCH_RESULTS_STORAGE = {
    key: "playground_batch_backtest_latest_results",
    schema: "batch_backtest.latest_results",
    version: 1,
} as const;

const BATCH_ACTIVE_SERVER_RUN_STORAGE = {
    key: "playground_batch_backtest_active_server_run",
    schema: "batch_backtest.active_server_run",
    version: 1,
} as const;

type BatchPersistedActiveServerRun = {
    runId: string;
    startedAt: number;
};

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
    private lastOpenScoreUsdResult: OpenScoreUsdReplayResult | null = null;
    /**
     * Last successful Balanced Generator result. Used by Copy Generated so a
     * user can copy the displayed list without re-running the generator. The
     * pair list is NOT applied to the textarea on Copy; only Generate-and-Apply
     * writes the textarea (and dispatches the existing input invalidation).
     */
    private lastBalancedPairListResult: BalancedPairListResult | null = null;
    /**
     * Provenance of the pair list CURRENTLY applied to the textarea, retained
     * only while the textarea's content still matches `provenance.emittedPairListHash`.
     * Cleared by manual edits, Generate failure, or any other textarea mutation
     * that does not come from the generator's apply path.
     */
    private activePairListProvenance: PairListProvenanceV1 | null = null;
    private lastRunFingerprint: string | null = null;
    private lastRunInterval: string | null = null;
    // The strategy key that governed the last Run, captured at run start so
    // the persisted snapshot reflects the strategy that actually ran — not
    // whatever is selected in `state` later.
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
    // Audit single-flight finding: closes the double-click window between the
    // user's click and the Run button being disabled (which happens ~50 lines
    // into runBatch, after the first awaits). Without this guard, a rapid
    // double-click stacks two runBatch() invocations on the event loop before
    // either can disable the button — both pass the local preflight and the
    // second one steals ownership from the first.
    private runInFlight = false;
    /**
     * Shared UI single-flight lock for TOP_MEAN / stability (and any other
     * Batch action that awaits before claiming ownership). Complements
     * `runInFlight` so rapid clicks cannot stack overlapping POSTs or replace
     * the active run id while another action is mid-preflight.
     */
    private batchActionInFlight = false;
    /** True while the TOP_MEAN reattach serial poll loop owns the UI. */
    private topMeanReattachInFlight = false;
    /**
     * TOP_MEAN reattach cancellation + transient-failure backoff (mirrors the
     * normal-Batch reattach fields of the same suffix). The prior TOP_MEAN
     * reattach loop had no backoff — a single non-2xx or thrown fetch
     * abandoned the entire reattach and cleared the persisted run marker — and
     * no cancellation hook, so Stop had to wait for the in-flight 2s delay to
     * elapse before the loop noticed. These fields close both gaps.
     */
    private topMeanReattachTimer: ReturnType<typeof setTimeout> | null = null;
    private topMeanReattachTimerResolve: (() => void) | null = null;
    private topMeanReattachConsecutiveFailures = 0;
    // Browser-generated server run id (audit Finding 5). Sent on the /run body
    // and the /stop body so the server can scope Stop to THIS run: a stale tab
    // cannot cancel a newer run. Reattach also matches this against the
    // terminal snapshot's runId to decide whether to adopt the recovered run.
    private activeServerRunId: string | null = null;
    private serverRunActive = false;
    // Serializes OPEN_SCORE USD Replay (and any future server-side analysis).
    private analysisInFlight = false;
    // Set when Stop races analysis preflight or POST establishment.
    private analysisCancelRequested = false;
    // /stop is not operation-scoped, so new work must wait for every request.
    private pendingStopPromise: Promise<void> | null = null;
    // True when the most recent server-side Run finished with artifacts still
    // on the server (the OPEN_SCORE USD button is enabled on this flag, NOT on
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
    // Benchmark snapshot for the Copy Benchmark button. The run phase records
    // wall clock + cache stats on completion. `null` until the run phase has
    // completed in this session.
    private lastBenchmark: BatchBenchmarkSnapshot | null = null;
    private pendingServerRunCacheStats: BatchBenchmarkCacheStats | null = null;

    private latestTopMeanResult: any = null;
    /** Terminal stability comparison from the last stability run. */
    private latestTopMeanStabilityResult: any = null;
    private activeTopMeanRunId: string | null = null;
    private topMeanDiagnosticRunId: string | null = null;
    private topMeanDiagnosticEntries: Array<{ at: string; type: string; data?: unknown }> = [];
    private topMeanDiagnosticProgressSeen = 0;

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    public init(): void {
        ensureLazyStylesheet("batch-backtest-styles", new URL("../../styles/batch-backtest.css", import.meta.url).href);
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.resetProgress(dom);
        this.loadPersistedLatestResults(dom);
        this.activeServerRunId = this.loadPersistedActiveServerRun()?.runId ?? null;
        this.serverRunActive = this.activeServerRunId !== null;
        this.updateSummary(dom);
        this.initialized = true;
        // Reattach to a server-side run that started before page load.
        void this.reattachToInProgressServerRun();
        void this.reattachToInProgressTopMeanRun();
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
        dom.batchBacktestOpenScoreUsdBtn.addEventListener("click", () => {
            void this.runOpenScoreUsdReplay();
        });
        dom.batchBacktestCopyOpenScoreUsdBtn.addEventListener("click", () => {
            void this.copyOpenScoreUsdResults();
        });
        dom.batchBacktestSp500TopMeanRunBtn.addEventListener("click", () => {
            void this.runSp500TopMeanCoordinator();
        });
        dom.batchBacktestSp500TopMeanStopBtn.addEventListener("click", () => {
            void this.stopSp500TopMeanCoordinator();
        });
        dom.batchBacktestSp500TopMeanCopyBtn.addEventListener("click", () => {
            void this.copySp500TopMeanResults();
        });
        dom.batchBacktestSp500TopMeanDownloadBtn.addEventListener("click", () => {
            void this.downloadSp500TopMeanResults();
        });
        dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.addEventListener("click", () => {
            void this.copySp500TopMeanDiagnostic();
        });
        dom.batchBacktestSp500TopMeanStabilityRunBtn.addEventListener("click", () => {
            void this.runSp500TopMeanStabilityCheck();
        });
        dom.batchBacktestSymbolTemplate.addEventListener("change", async () => {
            const key = dom.batchBacktestSymbolTemplate.value as BatchSymbolTemplateKey;
            if (!key) return;
            // Lazy-load the ~13KB pair-list blob only when a template is
            // actually picked, keeping it out of the cold-start bundle.
            const { BATCH_SYMBOL_TEMPLATES } = await import("./batch-symbol-templates");
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
            // Fast path: when there is nothing derived from a prior run/cache
            // to invalidate (no fingerprint, no live results, no OPEN_SCORE USD
            // result, no active server run, no provenance to recheck), the
            // input event only needs the pair-count summary text. Skipping the
            // heavy path here avoids two `parseBatchSymbols` passes + a
            // `localStorage.removeItem` per keystroke while editing/pasting
            // large pair lists.
            const hasDerivedState = this.lastRunFingerprint !== null
                || this.lastResults.length > 0
                || this.lastOpenScoreUsdResult !== null
                || this.activeServerRunId !== null
                || this.activePairListProvenance !== null;
            if (hasDerivedState) {
                this.clearStaleResults(dom);
                this.clearActivePairListProvenanceIfStale(dom);
            }
            this.updateSummary(dom);
        });
        dom.batchBacktestBalancedGenerateBtn.addEventListener("click", () => {
            void this.generateAndApplyBalancedPairList();
        });
        dom.batchBacktestBalancedCopyBtn.addEventListener("click", () => {
            void this.copyBalancedPairList();
        });
    }

    /**
     * Synchronous shared busy gate for Batch UI actions. Fires before the first
     * await so rapid clicks cannot stack normal Batch, TOP_MEAN, stability,
     * analysis, Stop transitions, or reattach polling.
     */
    private isBatchUiBusy(): boolean {
        return (
            this.batchActionInFlight
            || this.runInFlight
            || this.analysisInFlight
            || this.serverRunActive
            || this.pendingStopPromise !== null
            || this.activeTopMeanRunId !== null
            || this.topMeanReattachInFlight
            || this.reattachTimer !== null
        );
    }

    private async runBatch(): Promise<void> {
        // Audit single-flight finding: this guard fires BEFORE any await and
        // before the Run button is disabled, so a rapid double-click on Run
        // cannot stack two invocations that both pass local preflight. The
        // button-disable further down stays as the visual signal; this is the
        // correctness gate. Also blocks when TOP_MEAN / analysis / reattach
        // owns the UI so Stop and completion handlers stay coherent.
        if (this.isBatchUiBusy()) {
            const dom = this.getDom();
            dom.batchBacktestStatus.textContent = "Batch is already running — wait for it to finish.";
            return;
        }
        this.runInFlight = true;
        try {
            await this.runBatchInner();
        } finally {
            this.runInFlight = false;
        }
    }

    private async runBatchInner(): Promise<void> {
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
        const runFingerprint = this.buildRunFingerprint(symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, this.activePairListProvenance, interval);

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
        // Audit Finding 5: clear the active server run id at the start of each
        // new run; `runBatchServer` assigns a fresh one before POSTing.
        this.activeServerRunId = null;
        this.clearActiveServerRun();
        this.clearPersistedLatestResults();
        this.stopReattachPoll();
        dom.batchBacktestRunBtn.disabled = true;
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestCopyBtn.disabled = true;
        dom.batchBacktestCopyBenchmarkBtn.disabled = true;
        this.setRunBusy(dom, true);
        this.clearStaleResults(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        // Batch has one execution path: the Vite dev server streams scalar
        // rows while retaining heavy analysis artifacts outside the browser tab.
        // Reset the prior run's server cache stats so they can't leak into the
        // next run's benchmark if the `done` event never arrives (cancel /
        // crash). `recordRunBenchmark` re-populates this from the `done` event
        // or the recovery/reattach path.
        this.pendingServerRunCacheStats = null;
        const runStartedAt = performance.now();
        // Audit benchmark-rows finding: the benchmark records ONLY after a
        // known terminal outcome. A run that threw before any terminal event
        // (HTTP failure, stream error before `done`) is recorded as
        // `incomplete` so the Copy Benchmark button is not enabled for a run
        // that never produced authoritative results.
        let runOutcome: BatchBenchmarkRunOutcome = "done";
        let reachedTerminal = false;
        try {
            await this.runBatchServer(dom, token, symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint, (finalOutcome) => {
                // The server path resolves its terminal outcome AFTER all
                // recovery attempts. Capture it here so the benchmark reflects
                // what actually happened (done / cancelled) instead of guessing
                // from `this.cancelled` after the fact.
                reachedTerminal = true;
                runOutcome = finalOutcome;
            });
            reachedTerminal = true;
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.batchBacktestStatus.textContent = `Error: ${message}`;
            debugLogger.error("batch_backtest.run_failed", { error: message });
            // The run threw before any terminal event was processed. Preserve
            // `this.cancelled` as the dominant signal: a user-initiated Stop
            // surfaces a `cancelled` outcome so the benchmark distinguishes it
            // from an HTTP/stream `fatal`.
            runOutcome = this.cancelled ? "cancelled" : "fatal";
            reachedTerminal = this.cancelled;
        } finally {
            // Only restore buttons if this run is still the active one.
            if (token === this.runToken) {
                dom.batchBacktestRunBtn.disabled = false;
                setVisible(dom.batchBacktestStopBtn, false);
                dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
                // In server-side mode the artifacts stay on the server; the
                // OPEN_SCORE USD button must be gated on the `serverHasArtifacts`
                // flag (set by the `done` event), not on `row.data !== undefined`
                // (the browser never holds `row.data` in this mode).
                this.updateArtifactActionButtons(dom);
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
                this.setRunBusy(dom, false);
                // Audit benchmark-rows finding: record the benchmark only after
                // a known terminal outcome. A run that exited via HTTP/stream
                // failure without recovery is recorded as `incomplete` (still
                // observable, but clearly labeled). `this.cancelled` from the
                // user clicking Stop is a terminal outcome (`cancelled`).
                const benchmarkOutcome: BatchBenchmarkRunOutcome = reachedTerminal
                    ? runOutcome
                    : "incomplete";
                this.recordRunBenchmark("server", strategyKey, interval, runStartedAt, benchmarkOutcome);
            }
        }
    }

    /**
     * Server-side run path: POST to `/api/batch-backtest/run`, consume the
     * NDJSON stream, and populate `lastResults` with SCALARS ONLY (no `data`,
     * `signals`, or `result.trades`). The server retains the heavy arrays for
     * OPEN_SCORE USD Replay; the browser tab stays bounded regardless of pair
     * count.
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
        onTerminal: (outcome: BatchBenchmarkRunOutcome) => void,
    ): Promise<void> {
        // Audit Finding 5: generate a per-run id and send it on the /run body
        // so the server can scope Stop to THIS run. Adopted on the service so
        // Stop and reattach reconciliation send the same value.
        const runId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        if (token === this.runToken) {
            this.activeServerRunId = runId;
            this.serverRunActive = true;
            this.persistActiveServerRun(runId);
        }
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
                runId,
                // Phase 3 MAX_ACTIVE: attach the active pair-list provenance
                // (and null registration — Phase 4 commits it server-side).
                // The server verifies the hash, retains the meta on the run
                // snapshot, and threads the submitted degree map into the
                // OPEN_SCORE USD replay. Omitted when no provenance is
                // remembered (manual pair list, stale tab, etc.).
                ...(this.activePairListProvenance
                    ? { pairListProvenance: this.activePairListProvenance }
                    : {}),
            }),
        });
        if (!response.ok || !response.body) {
            // Audit NDJSON-POST-helper finding: use the shared error extractor
            // so this non-2xx path matches the centralized transport shape.
            // The run path keeps its own fetch because the stream is wrapped
            // in a try/catch + recovery flow that does not fit the helper's
            // single-shot POST+consume contract.
            const { message } = await extractBatchServerError(response, `Server run failed (${response.status}).`);
            if (!response.ok) this.clearActiveServerRun(runId);
            throw new Error(message);
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
                    // Audit benchmark-rows finding: surface a partial-artifact
                    // warning in the status line when the server retained some
                    // but not all analysis artifacts (disk pressure on a 1000-pair
                    // run). Keep the OPEN_SCORE USD button enabled as long as any
                    // artifact survived — analysis still works on the survivors.
                    if (event.artifactStats && event.artifactStats.failed > 0) {
                        const { stored, eligible, failed } = event.artifactStats;
                        const base = doneSummary ?? `Done — ${this.lastResults.length} pairs`;
                        doneSummary = `${base} — artifacts ${stored}/${eligible}; OPEN_SCORE USD will omit ${failed} failed write${failed === 1 ? "" : "s"}.`;
                    }
                    this.serverRunActive = false;
                    this.clearActiveServerRun(runId, false);
                    setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
                    dom.batchBacktestStatus.textContent = doneSummary;
                    // Audit benchmark-rows finding: report a terminal outcome.
                    // `done.cancelled` is set by the server when its run loop
                    // observed ownership loss (Stop). A clean done is "done".
                    onTerminal(event.cancelled ? "cancelled" : "done");
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
            // Recovery adopted the server's terminal snapshot — the run reached
            // a known terminal outcome even though the stream broke mid-flight.
            // `this.cancelled` reflects whether Stop was clicked locally.
            onTerminal(this.cancelled ? "cancelled" : "done");
        } else if (streamError !== null) {
            // Terminal `done` was processed before the stream later errored —
            // the run is complete; the trailing error is informational only.
            debugLogger.warn("batch.server.stream_closed_after_done", {
                error: streamError instanceof Error ? streamError.message : String(streamError),
            });
        }
        if (token !== this.runToken) return;
        if (doneSummary !== null) {
            this.serverRunActive = false;
            this.clearActiveServerRun(runId, false);
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
            // Audit runId-scoping finding: scope the initial status probe to
            // the active run id so a different generation's terminal snapshot
            // is not adopted by mistake. The helper returns `runMismatch` when
            // the server's retained run is no longer the one this tab started.
            const scopeRunId = this.activeServerRunId ?? undefined;
            const firstResponse = await fetch(
                scopeRunId
                    ? `/api/batch-backtest/status?runId=${encodeURIComponent(scopeRunId)}`
                    : "/api/batch-backtest/status",
                { cache: "no-store" },
            );
            if (!firstResponse.ok) return null;
            const firstPayload = await firstResponse.json() as {
                running?: boolean;
                runMismatch?: boolean;
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
                    runId?: string;
                } | null;
            };
            // Audit runId-scoping finding: the server confirmed the retained
            // run is no longer ours. Treat as not-adoptable so the caller
            // surfaces the original stream error instead of partial recovery.
            if (firstPayload.runMismatch) return null;
            const lastRun = firstPayload.lastRun;
            if (firstPayload.running || !lastRun || lastRun.fingerprint !== runFingerprint) {
                return null;
            }
            // Audit Finding 5: when both the browser and the server carry a
            // runId, they must match — a reloaded tab must not adopt a
            // different run that happens to share the fingerprint.
            if (
                this.activeServerRunId
                && typeof lastRun.runId === "string"
                && lastRun.runId
                && lastRun.runId !== this.activeServerRunId
            ) {
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

            // Audit status-row-recovery finding: route through the shared
            // `reconcileStatusRows` helper so the streamed prefix and the
            // recovered rows cannot double-append. The helper dedupes by
            // absolute index (offset+i) and is the single place that pushes
            // to `lastResults` and `appendResultRows`.
            const serverRowCount = Math.max(0, Math.floor(Number(lastRun.rowCount ?? 0)));
            const nextOffset = Array.isArray(lastRun.rows)
                ? (lastRun.nextOffset === undefined ? null : lastRun.nextOffset)
                : null;
            this.reconcileStatusRows(dom, lastRun.rows, lastRun.rowOffset, scopeRunId);

            // Drain remaining pages from the server offset until the server
            // signals no more rows (`nextOffset === null`). The status endpoint
            // bounds rows-per-response and returns `nextOffset` only when more
            // remain; the non-progressing-cursor guard below + the absolute
            // row-count / iteration caps prevent a misbehaving server from
            // looping the browser forever.
            let guard = 0;
            let cursor = nextOffset;
            let lastCursor = cursor;
            while (
                typeof cursor === "number"
                && this.lastResults.length < serverRowCount
                && this.lastResults.length < MAX_ROWS_TO_RECONSTRUCT
                && guard < MAX_ROWS_TO_RECONSTRUCT
            ) {
                guard += 1;
                const pageResponse = await fetch(
                    `/api/batch-backtest/status?after=${cursor}&limit=${PAGE_LIMIT}`
                    + (scopeRunId ? `&runId=${encodeURIComponent(scopeRunId)}` : ""),
                    { cache: "no-store" },
                );
                if (!pageResponse.ok) break;
                const pagePayload = await pageResponse.json() as {
                    runMismatch?: boolean;
                    lastRun?: {
                        rows?: BatchBacktestSymbolResult[];
                        rowOffset?: number;
                        nextOffset?: number | null;
                    } | null;
                };
                // Audit runId-scoping finding: stop paginating the moment the
                // server signals the run id is no longer ours (a newer run
                // started during the drain).
                if (pagePayload.runMismatch) break;
                const page = pagePayload.lastRun;
                if (!page || !Array.isArray(page.rows) || page.rows.length === 0) break;
                const pageOffset = Math.max(0, Math.floor(Number(page.rowOffset ?? cursor)));
                this.reconcileStatusRows(dom, page.rows, pageOffset, scopeRunId);
                lastCursor = cursor;
                cursor = page.nextOffset === undefined ? null : page.nextOffset;
                if (
                    cursor !== null
                    && cursor <= pageOffset + page.rows.length
                ) {
                    break; // non-progressing cursor guard
                }
                if (cursor === lastCursor) break;
            }

            setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
            this.updateArtifactActionButtons(dom);
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

    /**
     * Single source of truth for accepting status-page rows (audit status-row
     * -recovery finding). Dedupes by absolute index against `lastResults` so a
     * streamed prefix + a recovery page cannot double-append (the previous
     * bespoke code appended the whole first page to the DOM while only pushing
     * the missing prefix to `lastResults`, producing duplicate DOM rows).
     * Returns the rows actually accepted; never throws on dupes or runId
     * mismatch.
     *
     * `expectedRunId` is informational — the server has already rejected the
     * page on a mismatch (runMismatch), but the helper still skips work if the
     * caller can detect a stale row array locally.
     */
    private reconcileStatusRows(
        dom: BatchBacktestDom,
        rows: readonly BatchBacktestSymbolResult[] | undefined,
        rowOffsetRaw: number | undefined,
        _expectedRunId?: string,
    ): BatchBacktestSymbolResult[] {
        if (!rows || rows.length === 0) return [];
        const rowOffset = Math.max(0, Math.floor(Number(rowOffsetRaw ?? 0)));
        const accepted: BatchBacktestSymbolResult[] = [];
        for (let i = 0; i < rows.length; i += 1) {
            const absoluteIndex = rowOffset + i;
            // Skip rows the browser already holds (absolute index is already
            // present). This is the dedupe invariant: streamed prefix + later
            // recovery pages converge to exactly the server's row list.
            if (absoluteIndex < this.lastResults.length + accepted.length) continue;
            accepted.push(rows[i]!);
        }
        if (accepted.length === 0) return [];
        for (const row of accepted) {
            this.lastResults.push(row);
            this.appendedCount += 1;
        }
        this.appendResultRows(dom, accepted);
        return accepted;
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
        outcome: BatchBenchmarkRunOutcome,
    ): void {
        const totalMs = performance.now() - startedAt;
        // Classify pairs by synthetic vs real. parsePortfolioSyntheticPairSymbol
        // returns non-null only for `BASE+QUOTE` tokens.
        let synthetic = 0;
        let real = 0;
        // Audit benchmark-rows finding: classify each row into completed /
        // failed / cancelled buckets so a fast Stop no longer counts its
        // unattempted tail as "loaded". `skipped` rows are cancelled slots the
        // runner synthesized when its loop broke early; `no_trades` means the
        // strategy actually ran and produced zero trades, so it counts as
        // completed.
        let completed = 0;
        let failed = 0;
        let cancelled = 0;
        for (const row of this.lastResults) {
            if (parsePortfolioSyntheticPairSymbol(row.symbol)) synthetic += 1;
            else real += 1;
            switch (row.status) {
                case "load_failed":
                case "run_failed":
                    failed += 1;
                    break;
                case "skipped":
                    cancelled += 1;
                    break;
                default:
                    completed += 1;
            }
        }
        // Legacy `loaded` keeps its pre-fix meaning ("not load_failed/run_failed")
        // so downstream consumers (existing snapshots, copied JSON) stay
        // backward-compatible. It now includes `skipped` rows for the same
        // reason it did before: those rows have a non-failure status. The new
        // `completed`/`cancelled` split is the accurate breakdown.
        const loaded = this.lastResults.filter((r) => r.status !== "load_failed" && r.status !== "run_failed").length;
        const attempted = this.lastResults.length;
        const phase: BatchBenchmarkRunPhase = {
            totalMs,
            loaded,
            failed,
            synthetic,
            real,
            avgMsPerLoaded: benchmarkRatio(totalMs, loaded),
            attempted,
            completed,
            cancelled,
            skipped: cancelled,
            outcome,
        };
        const cacheSource = this.resolveCacheSource(mode);
        const cache = cacheSource === "server_stream" && this.pendingServerRunCacheStats
            ? this.pendingServerRunCacheStats
            : cacheSource === "browser_loader"
                ? this.currentCacheStats()
                : this.emptyCacheStats();
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
            phases: { run: phase },
            cache,
            bottlenecks: [],
        };
        snapshot.bottlenecks = buildBatchBenchmarkBottlenecks(snapshot.phases, snapshot.cache, snapshot.cacheSource);
        this.lastBenchmark = snapshot;
        const dom = this.dom;
        if (dom) dom.batchBacktestCopyBenchmarkBtn.disabled = false;
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
        const lines = formatBatchOverallSummary(this.lastResults);
        // Include the completed OPEN_SCORE USD selector study in the main
        // Batch copy so MAX_ACTIVE and its controls are not lost when the user
        // uses Copy Results instead of the analysis-specific copy button.
        if (this.lastOpenScoreUsdResult?.reportLines.length) {
            lines.push("", ...this.lastOpenScoreUsdResult.reportLines);
        }
        const text = lines.join("\n");
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /** Cancel the Batch run and any analysis holding the server analysis lock. */
    private async stopServerWork(): Promise<void> {
        try {
            // Audit Finding 5: send the active run id so the server scopes
            // Stop to THIS run. A stale tab's mismatched id is rejected
            // without mutating the active run's ownership.
            const runId = this.activeServerRunId;
            const response = await fetch("/api/batch-backtest/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(runId ? { runId } : {}),
            });
            const payload = await response.json().catch(() => null) as { ok?: boolean } | null;
            if (response.ok && payload?.ok && runId) this.clearActiveServerRun(runId);
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
                    // Audit runId-scoping finding: server signals the retained
                    // run is no longer the one this tab asked about. Treated as
                    // "no longer our run" — the loop drops ownership below.
                    runMismatch?: boolean;
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
                        runId?: string;
                    } | null;
                    lastRun?: {
                        rowCount: number;
                        hasArtifacts: boolean;
                        fingerprint: string | null;
                        interval?: string | null;
                        strategyKey?: string | null;
                        cacheStats?: BatchDatasetCacheStats | null;
                        runId?: string;
                        phase?: "done" | "cancelled" | "fatal";
                        summary?: string | null;
                        error?: string | null;
                        // Audit status-row-recovery finding: terminal reattach
                        // now also drains `lastRun.rows` (previously ignored),
                        // so a tab that reloads after the run finished still
                        // recovers the result table.
                        rows?: BatchBacktestSymbolResult[];
                        rowOffset?: number;
                        nextOffset?: number | null;
                    } | null;
                };
                try {
                    // Audit runId-scoping finding: scope each poll to the
                    // active run id so a tab polling a stale generation stops
                    // seeing rows from a newer run. If `activeServerRunId` is
                    // unset (very first poll of a fresh tab), the request is
                    // unscoped and the server returns whatever it currently
                    // owns; the loop adopts the runId from the response below.
                    const initialRunId = this.activeServerRunId
                        ? `&runId=${encodeURIComponent(this.activeServerRunId)}`
                        : "";
                    const response = await fetch(`/api/batch-backtest/status?after=${this.lastResults.length}${initialRunId}`, { cache: "no-store" });
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
                // Audit runId-scoping finding: server confirmed the retained
                // run is no longer ours. Stop polling without adopting another
                // tab's snapshot. Keep the already-rendered rows in place.
                if (payload.runMismatch) {
                    if (!this.reattachPollingStopped) {
                        const dom = this.getDom();
                        dom.batchBacktestRunBtn.disabled = false;
                        setVisible(dom.batchBacktestStopBtn, false);
                        this.setRunBusy(dom, false);
                        this.updateSummary(dom);
                        dom.batchBacktestStatus.textContent = "Batch run was replaced by a newer run — click Run to start over.";
                    }
                    return;
                }
                if (!payload.running || !payload.run) {
                    const terminalRunId = payload.lastRun?.runId;
                    if (
                        this.activeServerRunId
                        && terminalRunId
                        && terminalRunId !== this.activeServerRunId
                    ) {
                        // This tab owns a different run. Do not adopt or render
                        // another tab's terminal snapshot.
                        return;
                    }
                    if (terminalRunId && !this.activeServerRunId) {
                        this.activeServerRunId = terminalRunId;
                    }
                    // Adopt any leftover server-side artifacts (OPEN_SCORE USD
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
                        // Audit status-row-recovery finding: drain the terminal
                        // snapshot's rows via the shared helper. Previously a
                        // tab that reloaded AFTER the run completed would see
                        // `hasArtifacts` but no rows and no Copy output. The
                        // helper dedupes by absolute index so a partial earlier
                        // render is preserved and only the gap is filled.
                        const dom = this.getDom();
                        this.reconcileStatusRows(dom, payload.lastRun.rows, payload.lastRun.rowOffset, terminalRunId);
                        // Audit status-row-recovery finding: drain remaining
                        // pages while the server reports more rows for this
                        // terminal snapshot. The pagination contract matches
                        // the recovery path (after + limit + runId scope).
                        let termCursor = payload.lastRun.nextOffset ?? null;
                        let termLastCursor = termCursor;
                        let termGuard = 0;
                        const TERM_PAGE_LIMIT = 250;
                        const TERM_MAX_PAGES = 40; // ~10k rows, matches recovery cap
                        while (
                            typeof termCursor === "number"
                            && termGuard < TERM_MAX_PAGES
                            && !this.reattachPollingStopped
                        ) {
                            termGuard += 1;
                            const termRunId = terminalRunId
                                ? `&runId=${encodeURIComponent(terminalRunId)}`
                                : "";
                            const pageResponse = await fetch(
                                `/api/batch-backtest/status?after=${termCursor}&limit=${TERM_PAGE_LIMIT}${termRunId}`,
                                { cache: "no-store" },
                            );
                            if (!pageResponse.ok) break;
                            const pagePayload = await pageResponse.json() as {
                                runMismatch?: boolean;
                                lastRun?: {
                                    rows?: BatchBacktestSymbolResult[];
                                    rowOffset?: number;
                                    nextOffset?: number | null;
                                } | null;
                            };
                            if (pagePayload.runMismatch) break;
                            const page = pagePayload.lastRun;
                            if (!page || !Array.isArray(page.rows) || page.rows.length === 0) break;
                            const pageOffset = Math.max(0, Math.floor(Number(page.rowOffset ?? termCursor)));
                            this.reconcileStatusRows(dom, page.rows, pageOffset, terminalRunId);
                            termLastCursor = termCursor;
                            termCursor = page.nextOffset ?? null;
                            if (termCursor === null || termCursor <= termLastCursor) break;
                        }
                        if (this.lastResults.length > 0) {
                            this.saveLatestResultsSnapshot();
                        }
                        // The browser does not have the per-row scalars for the
                        // prior run (the tab reloaded), but OPEN_SCORE USD can
                        // still consume retained artifacts before their TTL
                        // expires.
                        this.updateArtifactActionButtons(dom);
                    } else {
                        if (this.lastResults.length > 0) {
                            this.saveLatestResultsSnapshot();
                        }
                    }
                    if (payload.lastRun?.phase === "fatal") {
                        this.getDom().batchBacktestStatus.textContent =
                            `Server Batch failed: ${payload.lastRun.error ?? payload.lastRun.summary ?? "Unknown error"}`;
                    } else if (payload.lastRun?.summary) {
                        this.getDom().batchBacktestStatus.textContent = payload.lastRun.summary;
                    }
                    this.serverRunActive = false;
                    if (terminalRunId) this.clearActiveServerRun(terminalRunId, false);
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
                if (
                    this.activeServerRunId
                    && run.runId
                    && run.runId !== this.activeServerRunId
                ) {
                    // A persisted id from this tab does not own the server's
                    // current run; leave the other run untouched.
                    return;
                }
                if (run.runId && !this.activeServerRunId) {
                    this.activeServerRunId = run.runId;
                    this.persistActiveServerRun(run.runId);
                }
                this.serverRunActive = true;
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
                // Audit status-row-recovery finding: drain pages via the shared
                // `reconcileStatusRows` helper (the same one recovery and
                // terminal reattach use). The helper dedupes by absolute index
                // and is the single place that pushes to `lastResults` + DOM,
                // so any page boundary is safe. Without this drain a late
                // reload would catch up at one page per 2s poll. Paged
                // responses are scoped to the active run id so a newer run
                // started mid-drain cannot contaminate this tab's row list.
                this.reconcileStatusRows(dom, run.rows, run.rowOffset, this.activeServerRunId ?? undefined);
                let nextOffset = run.nextOffset;
                let lastOffset = nextOffset;
                for (;;) {
                    if (nextOffset === null || nextOffset === undefined) break;
                    const pageOffsetCheck = Math.max(0, Math.floor(Number(run.rowOffset ?? 0)));
                    if (nextOffset <= pageOffsetCheck + run.rows.length) break; // guard against non-progressing cursors
                    if (!payload.running || !payload.run) break;
                    const scopeQs = this.activeServerRunId
                        ? `&runId=${encodeURIComponent(this.activeServerRunId)}`
                        : "";
                    const nextResponse = await fetch(`/api/batch-backtest/status?after=${nextOffset}&limit=250${scopeQs}`, { cache: "no-store" });
                    if (!nextResponse.ok) break;
                    const nextPayload = await nextResponse.json() as {
                        runMismatch?: boolean;
                        run?: { rows: BatchBacktestSymbolResult[]; rowOffset?: number; nextOffset?: number | null } | null;
                    };
                    // Audit runId-scoping finding: stop the moment the server
                    // signals the run id is no longer ours.
                    if (nextPayload.runMismatch) break;
                    if (!nextPayload.run) break;
                    const np = nextPayload.run;
                    this.reconcileStatusRows(dom, np.rows, np.rowOffset, this.activeServerRunId ?? undefined);
                    lastOffset = nextOffset;
                    nextOffset = np.nextOffset === undefined ? null : np.nextOffset;
                    if (nextOffset === null || nextOffset === lastOffset) break;
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

    /**
     * OPEN_SCORE USD Replay: at each historical synthetic-pair decision event,
     * did selecting the highest positive OPEN_SCORE asset (traded vs USD at the
     * next bar's open, fixed-horizon) beat a uniform random pick among the
     * other positive candidates? Read-only on artifacts — no Batch result
     * change, no orders. v1 is an event-level selector study, not a portfolio
     * replay; the report labels TOP_RAW and TOP_ADJUSTED separately and never
     * picks the better-looking formula after seeing results.
     */
    private async runOpenScoreUsdReplay(): Promise<void> {
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.getDom();
        try {
            if (!this.serverHasArtifacts) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Run Batch first.";
                return;
            }
            if (!this.lastRunFingerprint) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Rerun Batch; settings or symbols changed.";
                dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
                return;
            }
            if (this.analysisCancelRequested) return;
            // Horizons: comma-separated positive bar counts. Required in v1.
            const horizonsRaw = dom.batchBacktestOpenScoreUsdHorizons.value.trim();
            const horizons = horizonsRaw
                ? horizonsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1).map((n) => Math.floor(n))
                : [];
            if (horizons.length === 0) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Enter at least one positive horizon (e.g. 12,24,48).";
                dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
                return;
            }
            // Optional decision-event date window (YYYY-MM-DD); blank = full side.
            const sampleFrom = dom.batchBacktestOpenScoreUsdFrom.value.trim();
            const sampleTo = dom.batchBacktestOpenScoreUsdTo.value.trim();
            // Slippage/commission are NOT request fields: the server derives
            // them from the retained Batch run's slippageBps / commission so
            // the OPEN_SCORE USD replay uses the same execution-cost
            // assumptions as the artifacts it reads.

            this.beginAnalysisBusy(dom);
            dom.batchBacktestOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestOpenScoreUsdSummary.textContent = "Replaying OPEN_SCORE events on server...";
            await postBatchNdjson<OpenScoreUsdReplayStreamEvent>({
                endpoint: "/api/batch-backtest/open-score-usd",
                body: {
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval,
                    horizons,
                    ...(sampleFrom ? { sampleFrom } : {}),
                    ...(sampleTo ? { sampleTo } : {}),
                },
                onResponse: () => this.reissueStopIfNeeded(),
                handlers: {
                    onStart: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "start" }>) => {
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.pairs} pairs / ${event.assets} assets / horizons [${event.horizons.join(",")}]`;
                    },
                    onPhase: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "phase" }>) => {
                        const pct = event.total > 0 ? Math.round((event.completed / event.total) * 100) : 0;
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.phase}: ${event.detail} (${pct}%, ${(event.elapsedMs / 1000).toFixed(1)}s)`;
                    },
                    onProgress: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "progress" }>) => {
                        const pct = event.total > 0 ? Math.round((event.completed / event.total) * 100) : 0;
                        const extra = [];
                        if (event.events !== undefined) extra.push(`${event.events} events`);
                        if (event.omitted !== undefined) extra.push(`${event.omitted} omitted`);
                        const tail = extra.length > 0 ? ` (${extra.join(", ")})` : "";
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.phase}: ${event.detail} (${pct}%, ${(event.elapsedMs / 1000).toFixed(1)}s)${tail}`;
                    },
                    onDone: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "done" }>) => {
                        if (event.ok === true && "result" in event && event.result) {
                            this.lastOpenScoreUsdResult = event.result;
                            dom.batchBacktestOpenScoreUsdSummary.textContent = event.result.reportLines.join("\n");
                            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = event.result.reportLines.length === 0;
                        } else if (event.ok === false && "summary" in event) {
                            dom.batchBacktestOpenScoreUsdSummary.textContent = event.summary ?? "OPEN_SCORE USD cancelled.";
                        } else {
                            dom.batchBacktestOpenScoreUsdSummary.textContent = "OPEN_SCORE USD finished.";
                        }
                    },
                    onFatal: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "fatal" }>) => {
                        throw new Error(event.error);
                    },
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastOpenScoreUsdResult = null;
            dom.batchBacktestOpenScoreUsdSummary.textContent = `OPEN_SCORE USD error: ${message}`;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            debugLogger.error("batch_open_score_usd.server_failed", { error: message });
        } finally {
            await this.finishAnalysisBusy(dom);
        }
    }

    private async copyOpenScoreUsdResults(): Promise<void> {
        if (!this.lastOpenScoreUsdResult) {
            uiManager.showToast("No OPEN_SCORE USD report to copy", "info");
            return;
        }
        const text = this.lastOpenScoreUsdResult.reportLines.join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast("OPEN_SCORE USD report copied", "success");
        } else {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * Authoritative guard for the Balanced Generator. Rejects the action
     * (without mutating either textarea or remembered provenance) whenever a
     * Batch run, analysis, Stop transition, or status reattach owns the UI.
     * The disabled button is the visual signal; THIS is the correctness gate.
     * Mirrors the runInFlight / analysisInFlight / pendingStopPromise
     * single-flight discipline the rest of the service uses.
     */
    private balancedGeneratorActionGuard(): boolean {
        return (
            this.runInFlight ||
            this.analysisInFlight ||
            this.pendingStopPromise !== null ||
            // A reloaded tab can have no local in-flight promise while the
            // server still owns the run. Do not let generator edits mutate
            // the submitted universe during that ownership window.
            this.serverRunActive
        );
    }

    /**
     * Balanced Generator — Generate-and-Apply. Reads the assets textarea,
     * maxPairs, and seed; runs the pure generator; on success writes the
     * generated pair list to the existing Pairs textarea and dispatches its
     * input event so the existing fingerprint/result invalidation path runs
     * exactly as if the user had pasted the list manually. On failure the
     * textarea and provenance are left untouched and actionable errors are
     * shown in the summary area.
     */
    private async generateAndApplyBalancedPairList(): Promise<void> {
        const dom = this.getDom();
        // Authoritative guard fires before any work; the disabled button is
        // the visual signal but cannot be the only gate (a stale tab could
        // re-enable it via reattach).
        if (this.balancedGeneratorActionGuard()) {
            dom.batchBacktestBalancedSummary.textContent =
                "Generator unavailable while a Batch run, analysis, or Stop transition is in progress.";
            return;
        }
        const rawAssets = dom.batchBacktestBalancedAssets.value;
        const assets = rawAssets.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        const maxPairs = this.readClampedInt(dom.batchBacktestBalancedMaxPairs.value, BALANCED_PAIR_LIST_MAX_PAIRS, 1, BALANCED_PAIR_LIST_MAX_PAIRS);
        const seedRaw = Number.parseInt(dom.batchBacktestBalancedSeed.value, 10);
        const seed = Number.isFinite(seedRaw) ? Math.max(1, Math.floor(seedRaw)) : 1;
        // The pure generator is synchronous; wrap in await so future async
        // extensions (canonicalization that needs a loader) plug in cleanly.
        const result = generateBalancedPairList({ assets, maxPairs, seed });
        if (!result.ok) {
            // Leave the textarea AND the provenance untouched.
            const errors = result.errors.length > 0 ? result.errors : ["Generation failed."];
            dom.batchBacktestBalancedSummary.textContent = errors.join("\n");
            dom.batchBacktestBalancedCopyBtn.disabled = true;
            return;
        }
        // Apply: write the textarea and dispatch the input event so the
        // existing fingerprint/result invalidation path runs identically to
        // a manual paste. Set the remembered provenance BEFORE the dispatch
        // so the input listener's stale-check sees the matching hash and
        // keeps it.
        this.lastBalancedPairListResult = result;
        this.activePairListProvenance = result.provenance;
        dom.batchBacktestSymbols.value = result.pairs.join("\n");
        dom.batchBacktestBalancedCopyBtn.disabled = false;
        dom.batchBacktestBalancedSummary.textContent = formatBalancedPairListSummary(result);
        // Dispatch the existing input invalidation path. Fall back to a
        // plain Event when InputEvent is not available (older Node test
        // harnesses without a DOM polyfill); the bound handler does not read
        // any InputEvent-specific field.
        const EventCtor = typeof InputEvent !== "undefined" ? InputEvent : Event;
        dom.batchBacktestSymbols.dispatchEvent(new EventCtor("input", { bubbles: true }));
        // The dispatched input handler runs clearStaleResults + updateSummary;
        // we then re-affirm the provenance (clearActivePairListProvenanceIfStale
        // inside the input handler keeps it because the hash matches).
    }

    private async copyBalancedPairList(): Promise<void> {
        const result = this.lastBalancedPairListResult;
        if (!result || !result.ok) {
            uiManager.showToast("No balanced pair list to copy", "info");
            return;
        }
        const text = [
            ...formatBalancedPairListReportLines(result),
            "",
            ...result.pairs,
        ].join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast(`Copied ${result.pairs.length} generated pairs`, "success");
        } else {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * If the textarea's content no longer matches the active provenance hash,
     * clear the remembered provenance. Called from the input handler so a
     * manual edit (or any other mutation) drops the link while a generator
     * apply re-sets it before the dispatch reaches here.
     */
    private clearActivePairListProvenanceIfStale(dom: BatchBacktestDom): void {
        if (!this.activePairListProvenance) return;
        const currentText = dom.batchBacktestSymbols.value;
        // Recompute the emitted-list hash with the same normalization the
        // generator used (parseBatchSymbols dedupes + uppercases + trims).
        const normalized = parseBatchSymbols(currentText);
        const currentHash = fnv1a64Hex(normalized.join("\n"));
        if (currentHash !== this.activePairListProvenance.emittedPairListHash) {
            this.activePairListProvenance = null;
        }
    }

    /** Server-side access to the active provenance (Phase 3 Batch run submission). */
    getActivePairListProvenance(): PairListProvenanceV1 | null {
        return this.activePairListProvenance;
    }

    private buildRunFingerprint(
        symbols: readonly string[],
        strategyKey: string,
        strategyParams: unknown,
        backtestSettings: unknown,
        capitalSettings: unknown,
        pairListProvenance: PairListProvenanceV1 | null,
        interval: string
    ): string {
        return buildBatchRunFingerprint({
            symbols,
            strategyKey,
            strategyParams,
            backtestSettings,
            capitalSettings,
            interval,
            pairListProvenance,
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
        this.lastRunFingerprint = snapshot.fingerprint;
        this.lastRunInterval = snapshot.interval || null;
        // Restore the strategy that governed the Run so the persisted snapshot
        // is correctly labeled. Older snapshots (pre-`strategyKey`) normalize
        // to `null`.
        this.lastRunStrategyKey = snapshot.strategyKey ?? null;
        this.appendedCount = snapshot.results.length;
        // LocalStorage cannot prove server artifact TTL is still valid, and
        // browser-mode heavy arrays are intentionally not restored. Reattach
        // status may re-enable OPEN_SCORE USD if server artifacts still exist.
        this.serverHasArtifacts = false;

        dom.batchBacktestResults.replaceChildren();
        this.appendResultRows(dom, this.lastResults);
        setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
        dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
        // Audit Mine-Prediction-gating finding: route every artifact-action
        // button (Mine, Stability, OPEN_SCORE USD) through the same helper so
        // a tab that reloads into restored-but-not-current state keeps all
        // three disabled consistently until a server-side run re-enables them.
        this.updateArtifactActionButtons(dom);
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

    private persistActiveServerRun(runId: string): void {
        writePersistedJson({
            ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
            data: { runId, startedAt: Date.now() },
            onError: (error) => debugLogger.warn("batch.active_server_run_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }

    private loadPersistedActiveServerRun(): BatchPersistedActiveServerRun | null {
        return readPersistedJson<BatchPersistedActiveServerRun | null>({
            ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
            fallback: null,
            migrate: ({ data }) => {
                if (!data || typeof data !== "object" || Array.isArray(data)) return null;
                const source = data as Partial<BatchPersistedActiveServerRun>;
                if (typeof source.runId !== "string" || !source.runId.trim()) return null;
                return {
                    runId: source.runId.trim(),
                    startedAt: typeof source.startedAt === "number" ? source.startedAt : Date.now(),
                };
            },
        });
    }

    private clearActiveServerRun(expectedRunId?: string, clearMemory = true): void {
        if (expectedRunId && this.activeServerRunId && this.activeServerRunId !== expectedRunId) return;
        if (clearMemory) {
            this.activeServerRunId = null;
            this.serverRunActive = false;
        }
        writePersistedJson({
            ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
            data: null,
            onError: (error) => debugLogger.warn("batch.active_server_run_clear_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }

    /**
     * Single source of truth for the artifact-action button (OPEN_SCORE USD).
     * Audit finding (artifact-action gating): an artifact-only button used to
     * stay enabled after `clearStaleResults` invalidated the fingerprint, so
     * the user could click a stale button and only then see "Run Batch first."
     * Locking the artifact-dependent button to the same
     * `serverHasArtifacts && lastRunFingerprint` gate keeps it consistent
     * across every lifecycle branch.
     */
    private updateArtifactActionButtons(dom: BatchBacktestDom): void {
        const available = this.serverHasArtifacts && Boolean(this.lastRunFingerprint);
        dom.batchBacktestOpenScoreUsdBtn.disabled = !available;
    }

    private updateBalancedGeneratorButtons(dom: BatchBacktestDom): void {
        const blocked = this.runInFlight || this.analysisInFlight
            || this.pendingStopPromise !== null || this.serverRunActive;
        dom.batchBacktestBalancedGenerateBtn.disabled = blocked;
        dom.batchBacktestBalancedCopyBtn.disabled = blocked || !this.lastBalancedPairListResult;
    }

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
     * instead of one per row. Output is identical to calling createResultRow
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
        this.lastOpenScoreUsdResult = null;
        dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdSummary.textContent = "";
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.lastRunStrategyKey = null;
        this.serverHasArtifacts = false;
        // Audit Finding 5: a stale run id must not survive a results clear.
        this.activeServerRunId = null;
        this.clearPersistedLatestResults();
        // Audit artifact-action-gating finding: the artifact-action button
        // shares this gate; clearing stale results disables OPEN_SCORE USD
        // consistently through one helper.
        this.updateArtifactActionButtons(dom);
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
        dom.batchBacktestBalancedGenerateBtn.disabled = busy;
        this.updateBalancedGeneratorButtons(dom);
    }

    private beginAnalysisBusy(dom: BatchBacktestDom): void {
        this.setRunBusy(dom, true);
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
    }

    // Keep operations disabled until unscoped /stop requests have settled.
    private async finishAnalysisBusy(dom: BatchBacktestDom): Promise<void> {
        this.analysisCancelRequested = false;
        this.setRunBusy(dom, false);
        setVisible(dom.batchBacktestStopBtn, false);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
        const pending = this.pendingStopPromise;
        if (pending) {
            try { await pending; } catch { /* stopServerWork swallows errors */ }
        }
        this.analysisInFlight = false;
        dom.batchBacktestRunBtn.disabled = false;
        // Audit artifact-action-gating finding: route the post-analysis restore
        // through the shared helper so Mine, Stability, and OPEN_SCORE USD
        // all flip back together based on the same gate.
        this.updateArtifactActionButtons(dom);
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

    public async runSp500TopMeanCoordinator(): Promise<void> {
        const dom = this.getDom();
        // Shared single-flight: must run before the first await so rapid clicks
        // cannot stack multiple coordinator POSTs or replace activeTopMeanRunId.
        if (this.isBatchUiBusy()) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Batch action already in progress — wait for it to finish.";
            return;
        }
        this.batchActionInFlight = true;
        try {
            await this.runSp500TopMeanCoordinatorInner(dom);
        } finally {
            this.batchActionInFlight = false;
        }
    }

    private async runSp500TopMeanCoordinatorInner(dom: BatchBacktestDom): Promise<void> {
        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategyKey || !strategy) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Custom/browser strategies cannot be run in Node worker coordinator. Please select a built-in strategy.";
            return;
        }

        const horizonsText = dom.batchBacktestSp500TopMeanHorizons.value.trim() || "12,24,48";
        const horizons = horizonsText
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);

        if (horizons.length === 0) {
            dom.batchBacktestSp500TopMeanProgressText.textContent = "Error: Invalid horizons format.";
            return;
        }

        const workersRaw = Number.parseInt(dom.batchBacktestSp500TopMeanWorkers.value, 10);
        const workerCount = Number.isFinite(workersRaw) && workersRaw > 0 ? workersRaw : undefined;

        const maxPairsRaw = Number.parseInt(dom.batchBacktestSp500TopMeanMaxPairs.value, 10);
        const maxPairs = Number.isFinite(maxPairsRaw) && maxPairsRaw > 0 ? maxPairsRaw : undefined;

        const runId = `sp500_top_mean_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        this.activeTopMeanRunId = runId;
        this.topMeanDiagnosticRunId = runId;
        this.topMeanDiagnosticEntries = [];
        this.topMeanDiagnosticProgressSeen = 0;
        writePersistedJson({
            key: "sp500_top_mean_active_run_id",
            schema: "sp500_top_mean_active_run_id.v1",
            version: 1,
            data: { runId },
        });

        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;

        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML = "";
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Starting S&P 500 TOP_MEAN coordinator...";
        dom.batchBacktestSp500TopMeanResults.innerHTML = "";
        this.recordTopMeanDiagnostic("ui.started", {
            runButtonDisplay: dom.batchBacktestSp500TopMeanRunBtn.style.display,
            stopButtonDisplay: dom.batchBacktestSp500TopMeanStopBtn.style.display,
        });

        const pairListTextRaw = dom.batchBacktestSymbols ? dom.batchBacktestSymbols.value.trim() : "";
        const pairListText = pairListTextRaw.length > 0 ? pairListTextRaw : undefined;

        // Optional decision-event date window for the phase-3 OPEN_SCORE USD
        // replay (YYYY-MM-DD); blank = full history. Mirrors the OPEN_SCORE USD
        // From/To controls. Pair backtests (phase 2) still cover full history.
        const sampleFrom = dom.batchBacktestSp500TopMeanFrom.value.trim();
        const sampleTo = dom.batchBacktestSp500TopMeanTo.value.trim();

        const payload = {
            runId,
            strategyKey,
            strategyParams: paramManager.getValues(strategy),
            backtestSettings: backtestService.getBacktestSettings(),
            capitalSettings: backtestService.getCapitalSettings(),
            interval: "4h",
            horizons,
            workerCount,
            maxPairs,
            pairListText,
            useRustEnginePreference: shouldUseRustEngine(),
            ...(sampleFrom ? { sampleFrom } : {}),
            ...(sampleTo ? { sampleTo } : {}),
        };
        const diagnosticPayload = {
            ...payload,
            pairListText: pairListText ? `${pairListText.split("\n").length} custom pair lines` : undefined,
        };
        this.recordTopMeanDiagnostic("run.start", {
            endpoint: "/api/batch-backtest/sp500-top-mean/run",
            request: diagnosticPayload,
            page: typeof location === "undefined" ? null : { href: location.href },
            userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
        });

        let reattachAfterError = false;
        try {
            await postBatchNdjson({
                endpoint: "/api/batch-backtest/sp500-top-mean/run",
                body: payload,
                onResponse: (response) => {
                    this.recordTopMeanDiagnostic("http.response", {
                        status: response.status,
                        ok: response.ok,
                        url: response.url,
                        contentType: response.headers.get("content-type"),
                    });
                },
                onNonOkResponse: (status, errorPayload) => {
                    this.recordTopMeanDiagnostic("http.error_response", {
                        status,
                        payload: errorPayload,
                    });
                },
                onEvent: (event: any) => {
                    this.recordTopMeanNdjsonEvent(event);
                },
                handlers: {
                    onPreflight: (event: any) => {
                        this.renderTopMeanCoverageSummary(dom, event.counts);
                    },
                    onProgress: (event: any) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent = `[${event.phase}] ${event.text}`;
                    },
                    onDone: (event: any) => {
                        if (event.interrupted) {
                            this.latestTopMeanResult = null;
                            dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
                            dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;
                            dom.batchBacktestSp500TopMeanProgressText.textContent = "TOP_MEAN run stopped.";
                            this.activeTopMeanRunId = null;
                            writePersistedJson({
                                key: "sp500_top_mean_active_run_id",
                                schema: "sp500_top_mean_active_run_id.v1",
                                version: 1,
                                data: null,
                            });
                            return;
                        }
                        this.latestTopMeanResult = event.result;
                        this.latestTopMeanStabilityResult = null;
                        this.renderTopMeanResults(dom, event.result);
                        dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        dom.batchBacktestSp500TopMeanProgressText.textContent = "TOP_MEAN run completed successfully.";
                        this.activeTopMeanRunId = null;
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                    },
                    onFatal: (event: any) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent = `Error: ${event.error}`;
                        this.activeTopMeanRunId = null;
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                    },
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // The server may have accepted the run before the stream failed.
            // Keep the persisted run id and recover through the serialized
            // status poll instead of leaving the UI permanently busy or
            // orphaning a live coordinator.
            reattachAfterError = this.activeTopMeanRunId === runId;
            this.recordTopMeanDiagnostic("run.error", {
                name: err instanceof Error ? err.name : typeof err,
                message,
                stack: err instanceof Error ? err.stack : undefined,
            });
            dom.batchBacktestSp500TopMeanProgressText.textContent = `Status: ${message}`;
        } finally {
            if (reattachAfterError) {
                void this.reattachToInProgressTopMeanRun();
            } else {
                setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, true);
                setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
            }
            this.recordTopMeanDiagnostic("ui.finally", {
                runButtonDisplay: dom.batchBacktestSp500TopMeanRunBtn.style.display,
                stopButtonDisplay: dom.batchBacktestSp500TopMeanStopBtn.style.display,
                activeRunId: this.activeTopMeanRunId,
                progressText: dom.batchBacktestSp500TopMeanProgressText.textContent,
            });
        }
    }

    /**
     * Phase-2 gate check: run the current TOP_MEAN snapshot across N user-chosen
     * start dates (plus full history) and show a stability/diff view. If every
     * window picks the same winner, continuation parity holds and incremental
     * checkpoints (Phase 2) are viable for this config. POSTs to the SAME run
     * endpoint with `stabilityStartDates`; the engine then emits a terminal
     * `stability_done` event with the comparison. UI-only — no CLI.
     */
    public async runSp500TopMeanStabilityCheck(): Promise<void> {
        const dom = this.getDom();
        if (this.isBatchUiBusy()) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Batch action already in progress — wait for it to finish.";
            return;
        }
        this.batchActionInFlight = true;
        try {
            await this.runSp500TopMeanStabilityCheckInner(dom);
        } finally {
            this.batchActionInFlight = false;
        }
    }

    private async runSp500TopMeanStabilityCheckInner(dom: BatchBacktestDom): Promise<void> {
        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategyKey || !strategy) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Custom/browser strategies cannot be run in Node worker coordinator. Please select a built-in strategy.";
            return;
        }

        if (!dom.batchBacktestSp500TopMeanStabilityEnabled.checked) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Enable the Stability check checkbox, or use Run TOP_MEAN for a normal run.";
            return;
        }

        // Parse comma-separated UTC dates (YYYY-MM-DD -> UTC midnight seconds).
        const datesText = dom.batchBacktestSp500TopMeanStabilityDates.value.trim();
        const parsed: number[] = [];
        for (const tok of datesText.split(",").map((s) => s.trim()).filter(Boolean)) {
            const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tok);
            const year = parts ? Number(parts[1]) : NaN;
            const month = parts ? Number(parts[2]) : NaN;
            const day = parts ? Number(parts[3]) : NaN;
            const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
                ? new Date(Date.UTC(year, month - 1, day))
                : null;
            const valid = date !== null
                && date.getUTCFullYear() === year
                && date.getUTCMonth() === month - 1
                && date.getUTCDate() === day;
            if (!valid) {
                dom.batchBacktestSp500TopMeanProgressText.textContent =
                    `Error: Invalid start date "${tok}". Use YYYY-MM-DD, comma-separated.`;
                return;
            }
            parsed.push(Math.floor(date.getTime() / 1000));
        }
        if (parsed.length === 0) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Provide at least one start date (YYYY-MM-DD, comma-separated).";
            return;
        }

        const workerCountRaw = Number.parseInt(dom.batchBacktestSp500TopMeanWorkers.value, 10);
        const workerCount = Number.isFinite(workerCountRaw) && workerCountRaw > 0 ? workerCountRaw : undefined;
        const maxPairsRaw = Number.parseInt(dom.batchBacktestSp500TopMeanMaxPairs.value, 10);
        const maxPairs = Number.isFinite(maxPairsRaw) && maxPairsRaw > 0 ? maxPairsRaw : undefined;

        const runId = `sp500_stability_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        this.activeTopMeanRunId = runId;
        this.topMeanDiagnosticRunId = runId;
        this.topMeanDiagnosticEntries = [];
        this.topMeanDiagnosticProgressSeen = 0;
        writePersistedJson({
            key: "sp500_top_mean_active_run_id",
            schema: "sp500_top_mean_active_run_id.v1",
            version: 1,
            data: { runId },
        });

        setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;
        this.latestTopMeanResult = null;
        this.latestTopMeanStabilityResult = null;

        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML = "";
        dom.batchBacktestSp500TopMeanProgressText.textContent =
            `Starting stability check: ${parsed.length} start date${parsed.length === 1 ? "" : "s"} + full history...`;
        dom.batchBacktestSp500TopMeanResults.innerHTML = "";
        this.recordTopMeanDiagnostic("stability.ui.started", { runId, windowCount: parsed.length + 1 });

        const pairListTextRaw = dom.batchBacktestSymbols ? dom.batchBacktestSymbols.value.trim() : "";
        const pairListText = pairListTextRaw.length > 0 ? pairListTextRaw : undefined;

        const payload = {
            runId,
            strategyKey,
            strategyParams: paramManager.getValues(strategy),
            backtestSettings: backtestService.getBacktestSettings(),
            capitalSettings: backtestService.getCapitalSettings(),
            interval: "4h",
            horizons: [12],
            workerCount,
            maxPairs,
            pairListText,
            useRustEnginePreference: shouldUseRustEngine(),
            stabilityStartDates: parsed,
        };

        let reattachAfterError = false;
        try {
            await postBatchNdjson({
                endpoint: "/api/batch-backtest/sp500-top-mean/run",
                body: payload,
                terminalTypes: ["stability_done", "done", "fatal"],
                onResponse: (response) => {
                    this.recordTopMeanDiagnostic("stability.http.response", {
                        status: response.status,
                        ok: response.ok,
                    });
                },
                onNonOkResponse: (status, errorPayload) => {
                    this.recordTopMeanDiagnostic("stability.http.error_response", { status, payload: errorPayload });
                },
                onEvent: (event: any) => {
                    this.recordTopMeanNdjsonEvent(event);
                },
                handlers: {
                    onPreflight: (event: any) => {
                        this.renderTopMeanCoverageSummary(dom, event.counts);
                    },
                    onProgress: (event: any) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent =
                            event.phase === "stability"
                                ? `[stability ${event.currentWindow ?? "?"}/${event.totalWindows ?? "?"}] ${event.text}`
                                : `[${event.phase}] ${event.text}`;
                    },
                    onCurrentSnapshot: (event: any) => {
                        // Per-window snapshot arriving mid-run. Render each as a
                        // card so the user sees windows completing live. The
                        // terminal stability_done replaces this with the full
                        // comparison table.
                        if (event.currentSnapshot) {
                            this.appendStabilityWindowCard(dom, event);
                        }
                    },
                    onDone: (event: any) => {
                        // Stability mode does not emit a normal `done` with a
                        // result; it emits `stability_done`. The `done` here is
                        // the interrupted path only.
                        if (event.interrupted) {
                            this.latestTopMeanStabilityResult = null;
                            dom.batchBacktestSp500TopMeanProgressText.textContent = "Stability check stopped.";
                            this.activeTopMeanRunId = null;
                            writePersistedJson({
                                key: "sp500_top_mean_active_run_id",
                                schema: "sp500_top_mean_active_run_id.v1",
                                version: 1,
                                data: null,
                            });
                        }
                    },
                    onStabilityDone: (event: any) => {
                        this.latestTopMeanStabilityResult = event.comparison;
                        this.latestTopMeanResult = null;
                        this.renderStabilityResults(dom, event.comparison);
                        dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        const verdict = event.comparison?.parityAssumptionHolds ? "PASS" : "BLOCKED";
                        const agreement = Number(event.comparison?.agreementPct ?? 0).toFixed(1);
                        dom.batchBacktestSp500TopMeanProgressText.textContent =
                            `Stability check complete: gate ${verdict} (agreement ${agreement}%).`;
                        this.activeTopMeanRunId = null;
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                    },
                    onFatal: (event: any) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent = `Error: ${event.error}`;
                        this.activeTopMeanRunId = null;
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                    },
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // A stream failure does not prove that the server-side stability
            // job stopped. Reattach by run id so a failed browser connection
            // cannot strand the coordinator or leave the controls wedged.
            reattachAfterError = this.activeTopMeanRunId === runId;
            this.recordTopMeanDiagnostic("stability.run.error", {
                name: err instanceof Error ? err.name : typeof err,
                message,
                stack: err instanceof Error ? err.stack : undefined,
            });
            dom.batchBacktestSp500TopMeanProgressText.textContent = `Status: ${message}`;
        } finally {
            if (reattachAfterError) {
                void this.reattachToInProgressTopMeanRun();
            } else {
                setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, true);
                setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
            }
        }
    }

    /** Safe coverage summary — all numeric counts, no untrusted strings. */
    private renderTopMeanCoverageSummary(dom: BatchBacktestDom, counts: any): void {
        const c = counts ?? {};
        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML =
            `<strong>Universe Coverage:</strong> <strong>${escapeHtml(c.pairCount)} pairs</strong> | ` +
            `${escapeHtml(c.usableTargetIntervalCount)} target-usable assets | ` +
            `${escapeHtml(c.sp500AssetsCount)} total assets cataloged | ` +
            `${escapeHtml(c.excludedAssetsCount)} excluded assets`;
    }

    /** Render a single window's snapshot card as it arrives mid-stability-run. */
    private appendStabilityWindowCard(dom: BatchBacktestDom, event: any): void {
        const label = event.windowLabel ?? `Window ${(event.windowIndex ?? 0) + 1}`;
        const snap = event.currentSnapshot?.snapshot ?? event.currentSnapshot;
        const winners: any[] = Array.isArray(snap?.winners) ? snap.winners : [];
        const winnersText = winners.length > 0
            ? winners.map((w) => `${escapeHtml(w.asset)} (mean=${Number(w.mean ?? 0).toFixed(2)})`).join(", ")
            : `no pick (${escapeHtml(snap?.reason ?? "empty")})`;
        const card = document.createElement("div");
        card.style.cssText = "background: var(--surface-1, #131722); padding: 8px 12px; margin-bottom: 6px; border-radius: 4px; border-left: 3px solid var(--accent-color, #2962ff); font-size: 12px;";
        card.innerHTML = `<strong>${escapeHtml(label)}</strong> | openPositions=${escapeHtml(snap?.openPositions ?? 0)} | winners=${winnersText}`;
        dom.batchBacktestSp500TopMeanResults.appendChild(card);
    }

    /**
     * Terminal stability comparison view. Mirrors the walk-forward IS/OOS
     * side-by-side table precedent: one row per window, plus a verdict banner.
     */
    private renderStabilityResults(dom: BatchBacktestDom, comparison: any): void {
        if (!comparison || !Array.isArray(comparison.windows)) return;
        let html = "";

        const verdict = comparison.parityAssumptionHolds;
        const verdictColor = verdict ? "#26a69a" : "#ef5350";
        const verdictText = verdict
            ? "PASS — continuation parity holds; Phase 2 (incremental checkpoints) viable for this config"
            : "BLOCKED — winners diverge across start dates; Phase 2 not safe until path-dependence is resolved";
        html += `<div style="background: var(--surface-2, #1e222d); border: 1px solid var(--border-color, #2a2e39); border-left: 4px solid ${verdictColor}; border-radius: 6px; padding: 12px; margin-bottom: 12px;">`;
        html += `<div style="font-weight: bold; font-size: 14px; color: ${verdictColor}; margin-bottom: 6px;">STABILITY GATE: ${verdict ? "PASS" : "BLOCKED"}</div>`;
        html += `<div style="font-size: 12px; color: var(--text-color, #d1d4dc); margin-bottom: 4px;">${verdictText}</div>`;
        const agreement = Number(comparison.agreementPct ?? 0).toFixed(1);
        const drift = Number(comparison.maxMeanDrift ?? 0).toFixed(4);
        const common = Array.isArray(comparison.commonWinners) ? comparison.commonWinners.join(", ") : "";
        html += `<div style="font-size: 11px; color: var(--text-dim, #787b86);">agreement ${agreement}% | maxMeanDrift ${drift} | common winners: ${common || "(none)"}</div>`;
        html += `</div>`;

        html += `<table class="finder-table" style="width:100%; font-size:12px;">`;
        html += `<thead><tr><th>Window</th><th>asOf</th><th>reason</th><th>openPositions</th><th>Winners</th></tr></thead><tbody>`;
        for (const w of comparison.windows) {
            const snap = w.snapshot;
            const winners = Array.isArray(snap?.winners) ? snap.winners : [];
            const winnersText = winners.length > 0
                ? winners.map((x: any) => `<strong>${escapeHtml(x.asset)}</strong> (mean=${Number(x.mean ?? 0).toFixed(2)})`).join(", ")
                : `<span style="color: var(--text-dim, #787b86);">(no pick — ${escapeHtml(snap?.reason ?? "empty")})</span>`;
            const asOfLabel = typeof snap?.asOf === "number"
                ? new Date(snap.asOf * 1000).toISOString().slice(0, 10)
                : "—";
            html += `<tr><td>${escapeHtml(w.label)}</td><td>${escapeHtml(asOfLabel)}</td><td>${escapeHtml(snap?.reason ?? "")}</td><td>${escapeHtml(snap?.openPositions ?? 0)}</td><td>${winnersText}</td></tr>`;
        }
        html += `</tbody></table>`;
        dom.batchBacktestSp500TopMeanResults.innerHTML = html;
    }

    /** Copy the stability comparison as plain text (the opaque reportLines). */
    public async copySp500TopMeanStabilityResults(): Promise<void> {
        if (!this.latestTopMeanStabilityResult) return;
        const lines: string[] = Array.isArray(this.latestTopMeanStabilityResult.reportLines)
            ? this.latestTopMeanStabilityResult.reportLines
            : [];
        await copyToClipboard(lines.join("\n"));
        const dom = this.getDom();
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Copied stability comparison to clipboard.";
    }

    public async stopSp500TopMeanCoordinator(): Promise<void> {
        const runId = this.activeTopMeanRunId;
        if (!runId) {
            this.recordTopMeanDiagnostic("stop.ignored", { reason: "no active run id" });
            return;
        }
        // Audit: cancel any in-flight reattach poll delay so the loop notices
        // the Stop immediately instead of waiting up to the 15s backoff
        // ceiling. The loop's post-await guard then sees activeTopMeanRunId
        // change and exits cleanly.
        this.stopTopMeanReattachPoll();
        this.recordTopMeanDiagnostic("stop.request", { runId });
        try {
            const response = await fetch("/api/batch-backtest/sp500-top-mean/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId }),
            });
            this.recordTopMeanDiagnostic("stop.response", {
                runId,
                status: response.status,
                ok: response.ok,
                body: await response.text().catch(() => "<unreadable>"),
            });
        } catch (err) {
            this.recordTopMeanDiagnostic("stop.error", {
                runId,
                name: err instanceof Error ? err.name : typeof err,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private renderTopMeanResults(dom: BatchBacktestDom, summary: any): void {
        if (!summary || !Array.isArray(summary.horizons)) return;

        let html = "";

        // 0. Current TOP_MEAN snapshot (Phase 1): positions open at the latest
        // common closed candle. Surfaced separately from the historical
        // OPEN_SCORE replay leaderboard below — the two answer different
        // questions (cross-sectional "now" vs per-event historical edge).
        if (summary.currentSnapshot) {
            html += this.renderCurrentTopMeanBanner(summary.currentSnapshot);
        }

        // 1. Leaderboard Banner: Executive summary of top asset per horizon
        html += `<div style="background: var(--surface-2, #1e222d); border: 1px solid var(--border-color, #2a2e39); border-radius: 6px; padding: 12px; margin-bottom: 16px;">`;
        html += `<div style="font-weight: bold; font-size: 14px; margin-bottom: 8px; color: var(--accent-color, #2962ff);">🏆 TOP_MEAN Asset Leaderboard</div>`;
        html += `<div style="display: flex; gap: 16px; flex-wrap: wrap;">`;

        for (const h of summary.horizons) {
            const top = Array.isArray(h.topAssets) && h.topAssets.length > 0 ? h.topAssets[0] : null;
            if (top) {
                const sharePct = (top.share * 100).toFixed(1) + "%";
                html += `<div style="flex: 1; min-width: 180px; background: var(--surface-1, #131722); padding: 8px 12px; border-radius: 4px; border-left: 3px solid #26a69a;">`;
                html += `<div style="font-size: 11px; color: var(--text-dim, #787b86); text-transform: uppercase;">Horizon ${escapeHtml(h.horizon)} Bars</div>`;
                html += `<div style="font-size: 16px; font-weight: bold; margin: 2px 0;">${escapeHtml(top.asset)}</div>`;
                html += `<div style="font-size: 12px; color: var(--text-color, #d1d4dc);">${escapeHtml(top.events?.toLocaleString())} events (${escapeHtml(sharePct)} share)</div>`;
                html += `<div style="font-size: 11px; color: ${(top.delta ?? 0) >= 0 ? '#26a69a' : '#ef5350'}; margin-top: 2px;">Delta: ${escapeHtml(formatSignedPercent(top.delta))}</div>`;
                html += `</div>`;
            }
        }
        html += `</div></div>`;

        // 2. Detailed horizon tables with rank #1 badge
        for (const h of summary.horizons) {
            html += `<div style="margin-top: 16px; font-weight: bold; font-size: 13px;">`;
            html += `Horizon ${escapeHtml(h.horizon)} bars | ${escapeHtml(h.events?.toLocaleString())} decision events | `;
            html += `TOP_MEAN: top=${escapeHtml(formatSignedPercent(h.topMean?.topMean))} random=${escapeHtml(formatSignedPercent(h.topMean?.randomMean))} delta=${escapeHtml(formatSignedPercent(h.topMean?.delta))}`;
            html += `</div>`;

            html += `<table class="finder-table" style="width:100%; margin-top:6px; font-size:12px;">`;
            html += `<thead><tr><th>Rank</th><th>Asset</th><th>Events</th><th>Share</th><th>Selected Mean</th><th>Control Mean</th><th>Delta</th></tr></thead><tbody>`;

            let rank = 1;
            for (const row of h.topAssets || []) {
                const sharePct = (row.share * 100).toFixed(1) + "%";
                const isTop = rank === 1;
                html += `<tr style="${isTop ? 'background: rgba(38, 166, 154, 0.1); font-weight: 600;' : ''}">`;
                html += `<td>${isTop ? '🥇 1' : rank}</td>`;
                html += `<td><strong>${escapeHtml(row.asset)}</strong> ${isTop ? '<span style="font-size:10px; background:#26a69a; color:#fff; padding:1px 4px; border-radius:3px; margin-left:4px;">TOP</span>' : ''}</td>`;
                html += `<td>${escapeHtml(row.events?.toLocaleString())}</td>`;
                html += `<td>${escapeHtml(sharePct)}</td>`;
                html += `<td>${escapeHtml(formatSignedPercent(row.topMean))}</td>`;
                html += `<td>${escapeHtml(formatSignedPercent(row.randomMean))}</td>`;
                html += `<td>${escapeHtml(formatSignedPercent(row.delta))}</td>`;
                html += `</tr>`;
                rank++;
            }
            html += `</tbody></table>`;
        }
        dom.batchBacktestSp500TopMeanResults.innerHTML = html;
    }

    /**
     * Phase-1 current snapshot banner. Renders the cross-sectional TOP_MEAN
     * pick(s) at the latest common closed candle. Kept visually separate from
     * the historical leaderboard — different question, different evidence.
     * Reuses the existing results container; no new DOM id.
     */
    private renderCurrentTopMeanBanner(currentSnapshot: any): string {
        const snap: any = currentSnapshot.snapshot ?? currentSnapshot;
        const winners: any[] = Array.isArray(snap?.winners) ? snap.winners : [];
        const asOfSec: number | null = snap?.asOf ?? null;
        const asOfLabel = typeof asOfSec === "number"
            ? new Date(asOfSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
            : "no common endpoint";
        const reason: string = snap?.reason ?? "empty";
        const stats: any = currentSnapshot.stats ?? {};

        let html = `<div style="background: var(--surface-2, #1e222d); border: 1px solid var(--border-color, #2a2e39); border-radius: 6px; padding: 12px; margin-bottom: 16px;">`;
        html += `<div style="font-weight: bold; font-size: 14px; margin-bottom: 8px; color: var(--accent-color, #2962ff);">📍 CURRENT TOP_MEAN — positions open at last closed candle</div>`;
        html += `<div style="font-size: 11px; color: var(--text-dim, #787b86); margin-bottom: 8px;">as-of: ${asOfLabel} | artifacts ${snap?.artifacts ?? 0} | open positions ${snap?.openPositions ?? 0} | candidates ${snap?.candidates?.length ?? 0} | stale ${stats.staleEndpoints ?? 0} | missing ${stats.missingEndpoints ?? 0}</div>`;

        if (winners.length === 0) {
            const noPickMsg = reason === "tied"
                ? "Tie at the top — no unique pick."
                : reason === "no_positive_candidates"
                    ? "No positive-score asset with an open position."
                    : reason === "no_open_positions"
                        ? "No open positions at the common endpoint."
                        : "No provable current snapshot (missing or mixed endpoints).";
            html += `<div style="font-size: 13px; color: var(--text-color, #d1d4dc);">⚠️ ${noPickMsg}</div>`;
            html += `</div>`;
            return html;
        }

        html += `<div style="display: flex; gap: 12px; flex-wrap: wrap;">`;
        for (const w of winners) {
            const mean = Number(w.mean ?? 0);
            const meanSign = mean >= 0 ? "+" : "";
            html += `<div style="flex: 1; min-width: 180px; background: var(--surface-1, #131722); padding: 8px 12px; border-radius: 4px; border-left: 3px solid #26a69a;">`;
            html += `<div style="font-size: 11px; color: var(--text-dim, #787b86); text-transform: uppercase;">${winners.length > 1 ? "Tied Winner" : "Current Pick"}</div>`;
            html += `<div style="font-size: 16px; font-weight: bold; margin: 2px 0;">${escapeHtml(w.asset)}</div>`;
            html += `<div style="font-size: 12px; color: var(--text-color, #d1d4dc);">mean=${meanSign}${mean.toFixed(2)} | score=${escapeHtml(w.score)} | activePairs=${escapeHtml(w.activePairs)}</div>`;
            html += `</div>`;
        }
        html += `</div>`;
        if (winners.length > 1) {
            html += `<div style="font-size: 11px; color: var(--text-dim, #787b86); margin-top: 6px;">Tie shown as-is — no arbitrary asset-name tie-break. Treat as an unresolved decision.</div>`;
        }

        const leaderboard: any[] = Array.isArray(snap?.candidates) ? snap.candidates.slice(0, 10) : [];
        html += `<div style="margin-top: 12px; font-weight: bold; font-size: 13px;">🏆 CURRENT TOP_MEAN Leaderboard — top ${leaderboard.length}</div>`;
        html += `<table class="finder-table" style="width:100%; margin-top:6px; font-size:12px;"><thead><tr><th>Rank</th><th>Asset</th><th>Mean</th><th>Score</th><th>Active Pairs</th></tr></thead><tbody>`;
        leaderboard.forEach((candidate, index) => {
            const mean = Number(candidate.mean ?? 0);
            const meanSign = mean >= 0 ? "+" : "";
            const isTop = index === 0;
            html += `<tr style="${isTop ? "background: rgba(38, 166, 154, 0.1); font-weight: 600;" : ""}"><td>${isTop ? "🥇 1" : index + 1}</td><td><strong>${escapeHtml(candidate.asset)}</strong></td><td>${meanSign}${mean.toFixed(2)}</td><td>${escapeHtml(candidate.score)}</td><td>${escapeHtml(candidate.activePairs)}</td></tr>`;
        });
        html += `</tbody></table>`;
        html += `</div>`;
        return html;
    }

    /**
     * Phase-1 current snapshot lines for the Copy Results output. Mirrors the
     * banner content in plain text so the clipboard surface matches the UI.
     */
    private formatCurrentTopMeanLines(currentSnapshot: any): string[] {
        const snap: any = currentSnapshot.snapshot ?? currentSnapshot;
        const winners: any[] = Array.isArray(snap?.winners) ? snap.winners : [];
        const asOfSec: number | null = snap?.asOf ?? null;
        const asOfLabel = typeof asOfSec === "number"
            ? new Date(asOfSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
            : "no common endpoint";
        const reason: string = snap?.reason ?? "empty";
        const stats: any = currentSnapshot.stats ?? {};

        const lines: string[] = [];
        lines.push("----------------------------------------------------------------------");
        lines.push("📍 CURRENT TOP_MEAN | positions open at last closed candle");
        lines.push("----------------------------------------------------------------------");
        lines.push(`as-of=${asOfLabel} | artifacts=${snap?.artifacts ?? 0} | openPositions=${snap?.openPositions ?? 0} | candidates=${snap?.candidates?.length ?? 0} | stale=${stats.staleEndpoints ?? 0} | missing=${stats.missingEndpoints ?? 0}`);
        if (winners.length === 0) {
            const noPickMsg = reason === "tied"
                ? "tied at top — no unique pick"
                : reason === "no_positive_candidates"
                    ? "no positive-score asset with an open position"
                    : reason === "no_open_positions"
                        ? "no open positions at the common endpoint"
                        : "no provable current snapshot (missing or mixed endpoints)";
            lines.push(`CURRENT TOP_MEAN | NO PICK | ${noPickMsg}`);
        } else {
            for (const w of winners) {
                const mean = Number(w.mean ?? 0);
                const meanSign = mean >= 0 ? "+" : "";
                lines.push(`CURRENT TOP_MEAN | asOf=${asOfLabel} | winners=${w.asset} | mean=${meanSign}${mean.toFixed(2)} | score=${w.score} | activePairs=${w.activePairs}`);
            }
            if (winners.length > 1) {
                lines.push(`CURRENT TOP_MEAN | tie across ${winners.length} assets — unresolved decision`);
            }
            const leaderboard: any[] = Array.isArray(snap?.candidates) ? snap.candidates.slice(0, 10) : [];
            lines.push(`CURRENT TOP_MEAN LEADERBOARD | top ${leaderboard.length}`);
            leaderboard.forEach((candidate, index) => {
                const mean = Number(candidate.mean ?? 0);
                const meanSign = mean >= 0 ? "+" : "";
                lines.push(`CURRENT TOP_MEAN | rank=${index + 1} | asset=${candidate.asset} | mean=${meanSign}${mean.toFixed(2)} | score=${candidate.score} | activePairs=${candidate.activePairs}`);
            });
        }
        lines.push("");
        return lines;
    }

    public async copySp500TopMeanResults(): Promise<void> {
        // If the latest run was a stability check, route to its copy path.
        if (!this.latestTopMeanResult && this.latestTopMeanStabilityResult) {
            return this.copySp500TopMeanStabilityResults();
        }
        if (!this.latestTopMeanResult) return;
        const res = this.latestTopMeanResult;

        const lines: string[] = [
            "======================================================================",
            "🏆 TOP_MEAN ASSET LEADERBOARD SUMMARY",
            "======================================================================",
            `Run ID: ${res.runId || "--"}`,
            `Coverage: ${res.counts?.usableTargetIntervalCount ?? "--"} target assets | ${res.counts?.pairCount ?? "--"} pairs`,
            "",
        ];

        if (res.currentSnapshot) {
            lines.push(...this.formatCurrentTopMeanLines(res.currentSnapshot));
        }

        if (Array.isArray(res.horizons)) {
            for (const h of res.horizons) {
                lines.push(`--- HISTORICAL TOP_MEAN | Horizon ${h.horizon} Bars (${h.events?.toLocaleString()} decision events) ---`);
                lines.push(`HISTORICAL TOP_MEAN | horizon=${h.horizon} | top=${formatSignedPercent(h.topMean?.topMean)} rand=${formatSignedPercent(h.topMean?.randomMean)} delta=${formatSignedPercent(h.topMean?.delta)}`);
                lines.push("");
                lines.push("Top Asset Rankings:");
                const topAssets = Array.isArray(h.topAssets) ? h.topAssets : [];
                for (let i = 0; i < Math.min(10, topAssets.length); i++) {
                    const a = topAssets[i];
                    const sharePct = ((a.share ?? 0) * 100).toFixed(1) + "%";
                    lines.push(`  #${(i + 1).toString().padStart(2)} ${a.asset.padEnd(6)} | ${a.events?.toLocaleString().padStart(5)} events (${sharePct.padStart(5)} share) | top: ${formatSignedPercent(a.topMean)} | rand: ${formatSignedPercent(a.randomMean)} | delta: ${formatSignedPercent(a.delta)}`);
                }
                lines.push("");
            }
        }
        lines.push("======================================================================");

        const text = lines.join("\n");
        await copyToClipboard(text);
        const dom = this.getDom();
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Copied TOP_MEAN leaderboard summary to clipboard.";
    }

    public async copySp500TopMeanDiagnostic(): Promise<void> {
        const text = this.buildTopMeanDiagnosticText();
        await copyToClipboard(text);
        const dom = this.getDom();
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Copied TOP_MEAN diagnostic to clipboard.";
    }

    private buildTopMeanDiagnosticText(): string {
        const diagnostic = {
            schema: "sp500_top_mean_diagnostic.v1",
            runId: this.topMeanDiagnosticRunId,
            copiedAt: new Date().toISOString(),
            entries: this.topMeanDiagnosticEntries,
        };
        try {
            return JSON.stringify(diagnostic, null, 2);
        } catch (err) {
            return JSON.stringify({
                schema: diagnostic.schema,
                runId: diagnostic.runId,
                copiedAt: diagnostic.copiedAt,
                entries: [{
                    at: new Date().toISOString(),
                    type: "diagnostic.serialization_error",
                    data: { message: err instanceof Error ? err.message : String(err) },
                }],
            }, null, 2);
        }
    }

    private recordTopMeanNdjsonEvent(event: any): void {
        if (event?.type === "progress") {
            this.topMeanDiagnosticProgressSeen += 1;
            const completed = Number(event.completed);
            const total = Number(event.total);
            const progressOrdinal = this.topMeanDiagnosticProgressSeen;
            if (progressOrdinal > 3 && progressOrdinal !== total && progressOrdinal % 1000 !== 0 &&
                (!Number.isFinite(completed) || completed !== total) &&
                (!Number.isFinite(completed) || completed % 1000 !== 0)) {
                return;
            }
        }
        this.recordTopMeanDiagnostic(`ndjson.${event?.type || "unknown"}`, event);
    }

    private recordTopMeanDiagnostic(type: string, data?: unknown): void {
        this.topMeanDiagnosticEntries.push({ at: new Date().toISOString(), type, data });
        const dom = this.dom;
        if (!dom) return;
        dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.disabled = false;
        dom.batchBacktestSp500TopMeanDiagnostic.hidden = false;
        dom.batchBacktestSp500TopMeanDiagnostic.textContent = this.buildTopMeanDiagnosticText();
    }

    public downloadSp500TopMeanResults(): void {
        if (!this.latestTopMeanResult) return;
        const text = JSON.stringify(this.latestTopMeanResult, null, 2);
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sp500_top_mean_${this.latestTopMeanResult.runId || "result"}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    private async reattachToInProgressTopMeanRun(): Promise<void> {
        const persisted = readPersistedJson<{ runId: string }>({
            key: "sp500_top_mean_active_run_id",
            schema: "sp500_top_mean_active_run_id.v1",
            version: 1,
            fallback: { runId: "" },
            migrate: (ctx) => (ctx.data && typeof ctx.data === "object" ? (ctx.data as { runId: string }) : null),
        });
        if (!persisted?.runId) return;

        const dom = this.getDom();
        const runId = persisted.runId;
        this.activeTopMeanRunId = runId;
        this.topMeanDiagnosticRunId = runId;
        this.topMeanReattachInFlight = true;
        this.recordTopMeanDiagnostic("reattach.start", { runId });
        // A stability run reattach (runId prefix) hides BOTH run buttons so the
        // user cannot start a conflicting run while reattaching.
        const isStabilityReattach = runId.startsWith("sp500_stability_");
        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
        if (isStabilityReattach) {
            setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, false);
        }
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);

        // Serialized polling (mirrors normal Batch reattach). Never use
        // setInterval(async ...) — overlapping status callbacks can restore
        // buttons or replace results from a stale terminal response.
        //
        // Audit: this loop previously abandoned the reattach on the FIRST
        // non-2xx response or thrown fetch, clearing the persisted run marker
        // so even a transient dev-server hiccup lost the entire reattach. It
        // also used a bare setTimeout with no cancellation hook (Stop had to
        // wait the full 2s delay before the loop noticed). Both gaps are
        // closed below by porting the consecutive-failure backoff (2s → 5s →
        // 10s → 15s, give up after ~5 min at the 15s ceiling) and the
        // cancellable delay from `reattachToInProgressServerRun`.
        const FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;
        const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;
        const healthyDelay = (): Promise<void> => new Promise<void>((resolve) => {
            this.topMeanReattachTimerResolve = resolve;
            this.topMeanReattachTimer = setTimeout(resolve, 2_000);
        });
        this.topMeanReattachConsecutiveFailures = 0;
        try {
            while (this.activeTopMeanRunId === runId) {
                try {
                    const res = await fetch(
                        `/api/batch-backtest/sp500-top-mean/status?runId=${encodeURIComponent(runId)}`,
                        { cache: "no-store" },
                    );
                    if (this.activeTopMeanRunId !== runId) return;
                    this.recordTopMeanDiagnostic("reattach.response", {
                        runId,
                        status: res.status,
                        ok: res.ok,
                    });
                    // Audit: a non-2xx status is a transient failure, not a
                    // reason to abandon the reattach. Treat it like a thrown
                    // fetch so the backoff path engages; the prior behavior
                    // cleared the persisted run marker and tore down the
                    // reattach on a single hiccup.
                    if (!res.ok) {
                        throw new Error(`status ${res.status}`);
                    }
                    const status = await res.json();
                    if (this.activeTopMeanRunId !== runId) return;
                    this.recordTopMeanDiagnostic("reattach.status", status);
                    dom.batchBacktestSp500TopMeanProgressText.textContent =
                        `[${status.phase}] ${status.progressText}`;

                    const terminal = status.status === "completed"
                        || status.status === "failed"
                        || status.status === "interrupted";
                    if (terminal) {
                        setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                        setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, true);
                        setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
                        if (status.stabilityResult) {
                            this.latestTopMeanStabilityResult = status.stabilityResult;
                            this.latestTopMeanResult = null;
                            this.renderStabilityResults(dom, status.stabilityResult);
                            dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                            dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        } else if (status.result) {
                            this.latestTopMeanResult = status.result;
                            this.renderTopMeanResults(dom, status.result);
                            dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                            dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        }
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                        this.activeTopMeanRunId = null;
                        return;
                    }
                    if (status.stabilityProgress) {
                        setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, false);
                        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);
                    }
                    // Successful poll resets the transient-failure counter.
                    this.topMeanReattachConsecutiveFailures = 0;
                } catch (err) {
                    if (this.activeTopMeanRunId !== runId) return;
                    this.topMeanReattachConsecutiveFailures += 1;
                    this.recordTopMeanDiagnostic("reattach.error", {
                        runId,
                        consecutive: this.topMeanReattachConsecutiveFailures,
                        name: err instanceof Error ? err.name : typeof err,
                        message: err instanceof Error ? err.message : String(err),
                    });
                    if (this.topMeanReattachConsecutiveFailures > MAX_REATTACH_CONSECUTIVE_FAILURES) {
                        // Give up retrying but do NOT strand the UI: restore
                        // the run buttons and clear the persisted marker so a
                        // reload can reattach if the server recovers. Mirrors
                        // the normal-Batch give-up path.
                        setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                        setVisible(dom.batchBacktestSp500TopMeanStabilityRunBtn, true);
                        setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
                        this.activeTopMeanRunId = null;
                        writePersistedJson({
                            key: "sp500_top_mean_active_run_id",
                            schema: "sp500_top_mean_active_run_id.v1",
                            version: 1,
                            data: null,
                        });
                        dom.batchBacktestSp500TopMeanProgressText.textContent =
                            `Server connection lost — reload to reattach, or click TOP_MEAN to start over.`;
                        return;
                    }
                    dom.batchBacktestSp500TopMeanProgressText.textContent =
                        `Server connection interrupted — retrying (${this.topMeanReattachConsecutiveFailures}/${MAX_REATTACH_CONSECUTIVE_FAILURES})`;
                    const backoffIndex = Math.min(
                        this.topMeanReattachConsecutiveFailures - 1,
                        FAILURE_BACKOFF_MS.length - 1,
                    );
                    const backoffDelay = FAILURE_BACKOFF_MS[backoffIndex]!;
                    await new Promise<void>((resolve) => {
                        this.topMeanReattachTimerResolve = resolve;
                        this.topMeanReattachTimer = setTimeout(resolve, backoffDelay);
                    });
                    this.topMeanReattachTimer = null;
                    this.topMeanReattachTimerResolve = null;
                    continue;
                }
                await healthyDelay();
                this.topMeanReattachTimer = null;
                this.topMeanReattachTimerResolve = null;
            }
        } finally {
            if (this.activeTopMeanRunId === runId) {
                // Loop exited without a terminal status (e.g. Stop cleared id
                // from another path). Leave button state to that path.
            }
            this.stopTopMeanReattachPoll();
            this.topMeanReattachInFlight = false;
        }
    }

    /**
     * Cancel any in-flight TOP_MEAN reattach delay. Mirrors `stopReattachPoll`
     * for the normal-Batch loop: clears the timer + resolves the pending delay
     * promise so the loop wakes immediately, checks `activeTopMeanRunId`, and
     * exits when Stop has cleared the id.
     */
    private stopTopMeanReattachPoll(): void {
        if (this.topMeanReattachTimer) {
            clearTimeout(this.topMeanReattachTimer);
            this.topMeanReattachTimer = null;
        }
        if (this.topMeanReattachTimerResolve) {
            this.topMeanReattachTimerResolve();
            this.topMeanReattachTimerResolve = null;
        }
    }
}

function formatSignedPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

/**
 * Compact one-line summary of a Balanced Generator result for the UI status
 * area. Surfaces the effective seed/maxPairs, asset/relationship counts,
 * degree range, orientation imbalance, omitted count, and asset-list hash.
 */
function formatBalancedPairListSummary(result: BalancedPairListResult): string {
    if (!result.ok) {
        return result.errors.length > 0 ? result.errors.join("; ") : "Generation failed.";
    }
    const p = result.provenance;
    const omitted = result.omittedPairCount > 0 ? ` omitted=${result.omittedPairCount}` : "";
    const aliases = result.aliasCollisions.length > 0 ? ` aliases=${result.aliasCollisions.length}` : "";
    const invalid = result.invalidTokens.length > 0 ? ` invalid=${result.invalidTokens.length}` : "";
    return [
        `Balanced | seed=${p.effectiveSeed} max=${p.effectiveMaxPairs}`,
        `assets=${p.assetCount} pairs=${p.pairCount}`,
        `deg=${p.degree.min}-${p.degree.median.toFixed(1)}-${p.degree.max}`,
        `orientImbalance=${p.orientationImbalanceMax}`,
        `hash=${p.emittedPairListHash.slice(0, 12)}`,
    ].join(" ") + omitted + aliases + invalid;
}

/**
 * Multi-line report for Copy Generated. Mirrors the summary plus any warnings
 * and the provenance fields needed to verify the list server-side. Pair text
 * is appended separately by the caller so the report and the list stay
 * separable.
 */
function formatBalancedPairListReportLines(result: BalancedPairListResult): string[] {
    if (!result.ok) {
        return ["Balanced Generator failed.", ...result.errors];
    }
    const p = result.provenance;
    const lines: string[] = [
        `Balanced Generator | ${p.schema} | ${p.algorithm}`,
        `seed=${p.effectiveSeed} max=${p.effectiveMaxPairs} assets=${p.assetCount} pairs=${p.pairCount}`,
        `degree min=${p.degree.min} median=${p.degree.median.toFixed(2)} max=${p.degree.max}`,
        `orientationImbalanceMax=${p.orientationImbalanceMax}`,
        `candidatePairCount=${result.candidatePairCount} omitted=${result.omittedPairCount}`,
        `assetListHash=${p.canonicalAssetListHash}`,
        `pairListHash=${p.emittedPairListHash}`,
    ];
    for (const w of result.warnings) lines.push(`WARN: ${w}`);
    return lines;
}

export const batchBacktestService = new BatchBacktestService();
