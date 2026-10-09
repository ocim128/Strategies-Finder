/**
 * Batch run workflow owner: the Run/Stop lifecycle over the server NDJSON
 * stream, status pagination/reconciliation and recovery, the run-token gated
 * render queue, the benchmark snapshot, and the server-side reattach poll.
 *
 * Owns its mutable run state (run token, results list, fingerprints,
 * server-run id/artifacts flags, benchmark inputs, reattach timers/backoff).
 * Cross-workflow coordination stays with the facade: the busy gate is
 * injected (`isUiBusy`), the balanced-generator lock inputs via `balancedLock`,
 * and the shared pending-Stop
 * sequencing via `requestServerStop`.
 */
import { ensureBuiltInStrategyLoaded } from "../../strategies/built-in-catalog";
import { backtestService } from "../../backtest-service";
import { shouldUseRustEngine } from "../../engine-preferences";
import { paramManager } from "../../param-manager";
import { state } from "../../state";
import { strategyRegistry } from "../../../strategyRegistry";
import { setVisible } from "../../dom-utils";
import { debugLogger } from "../../debug-logger";
import { uiManager } from "../../ui-manager";
import { copyToClipboard } from "../../browser-transfer";
import { parseJsonPreservingNonFinite } from "../../json-utils";
import { parsePortfolioSyntheticPairSymbol } from "../../synthetic-pair-parser";
import { consumeNdjsonStream } from "../../ndjson-stream";
import { extractBatchServerError } from "../batch-ndjson-post";
import {
    parseBatchSymbols,
    BATCH_MAX_SYMBOLS,
    buildBatchRunFingerprint,
} from "../batch-run-contract";
import type { BatchBacktestSymbolResult } from "../batch-backtest-runner";
import { collectOpenPositionSymbols } from "../batch-open-positions";
import type { PairListProvenanceV1 } from "../balanced-pair-list-generator";
import { formatBatchOverallSummary } from "../batch-backtest-summary";
import type { BatchResultSortKey, BatchResultSortState } from "../batch-results-sort";
import {
    BATCH_BENCHMARK_SCHEMA,
    benchmarkRatio,
    buildBatchBenchmarkBottlenecks,
    buildCacheStatsFromLoader,
    type BatchBenchmarkCacheStats,
    type BatchBenchmarkRunOutcome,
    type BatchBenchmarkRunPhase,
    type BatchBenchmarkSnapshot,
} from "../batch-benchmark-snapshot";
import type { BatchDatasetCacheStats } from "../batch-dataset-loader-core";
import type { BatchBacktestPerformance, BatchStatusResponse, BatchStreamEvent } from "../batch-backtest-stream-types";
import { ReattachBackoffController } from "../reattach-backoff";
import { requestBatchControl } from "./batch-control-request";
import type { StrategyParams, BacktestSettings } from "../../types/strategies";
import type { CapitalSettings } from "../../types/backtest";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import type { BatchResultsView } from "./batch-results-view";
import {
    clearPersistedActiveServerRun,
    clearPersistedLatestResults,
    loadPersistedActiveServerRun,
    persistActiveServerRun,
    readLatestResultsSnapshot,
    saveLatestResultsSnapshot,
    type BatchPersistedActiveServerRun,
} from "./batch-browser-store";

type BatchStatusRowsPage = {
    rows?: BatchBacktestSymbolResult[];
    rowOffset?: number;
    nextOffset?: number | null;
};

export class BatchRunController {
    private readonly deps: {
        getDom: () => BatchBacktestDom;
        resultsView: BatchResultsView;
        onBusyStateChange?: () => void;
        /** Facade cross-workflow busy gate (synchronous single-flight). */
        isUiBusy: () => boolean;
        /** Balanced-generator lock inputs, computed from facade state. */
        balancedLock: () => { blocked: boolean; hasResult: boolean };
        getPairListProvenance: () => PairListProvenanceV1 | null;
        /** Shared pending-Stop sequencing (facade-owned; never coalesced). */
        requestServerStop: () => Promise<void>;
    };

    private cancelled = false;
    private disposed = false;
    private lastProgressPercent = 0;
    private readonly controlAbort = new AbortController();
    private reattachAbort: AbortController | null = null;
    private lastResults: BatchBacktestSymbolResult[] = [];
    private batchResultSort: BatchResultSortState | null = null;
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
    // concurrent runs from racing on `lastResults` and the results list.
    private runToken = 0;
    // Audit single-flight finding: closes the double-click window between the
    // user's click and the Run button being disabled. The facade's wrapper
    // reads this through isUiBusy.
    private inFlight = false;
    private get runInFlight(): boolean {
        return this.inFlight;
    }
    private set runInFlight(value: boolean) {
        this.inFlight = value;
        this.deps.onBusyStateChange?.();
    }
    // Browser-generated server run id (audit Finding 5). Sent on the /run body
    // and the /stop body so the server can scope Stop to THIS run: a stale tab
    // cannot cancel a newer run. Reattach also matches this against the
    // terminal snapshot's runId to decide whether to adopt the recovered run.
    private activeServerRunId: string | null = null;
    private serverActive = false;
    private get serverRunActive(): boolean {
        return this.serverActive;
    }
    private set serverRunActive(value: boolean) {
        this.serverActive = value;
        this.deps.onBusyStateChange?.();
    }
    // True when the most recent server-side Run finished with artifacts still
    // on the server (the OPEN_SCORE USD button is enabled on this flag, NOT on
    // `row.data !== undefined`, because in server-side mode the browser never
    // holds `row.data`).
    private serverHasArtifacts = false;
    // Benchmark snapshot for the Copy Benchmark button. The run phase records
    // wall clock + cache stats on completion. `null` until the run phase has
    // completed in this session.
    private lastBenchmark: BatchBenchmarkSnapshot | null = null;
    private pendingServerRunCacheStats: BatchBenchmarkCacheStats | null = null;
    private pendingServerRunCounts: { attempted: number; cancelled: number; failed: number } | null = null;
    private pendingServerRunPerformance: BatchBacktestPerformance | null = null;
    // Reattach polling timer id (set when this tab is observing a server-side
    // run that started before page load).
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private get reattachTimer(): ReturnType<typeof setTimeout> | null {
        return this.pollTimer;
    }
    private set reattachTimer(value: ReturnType<typeof setTimeout> | null) {
        this.pollTimer = value;
        this.deps.onBusyStateChange?.();
    }
    private reattachTimerResolve: (() => void) | null = null;
    private reattachPollingStopped = false;
    // Consecutive failed status polls during a reattach (audit Finding 4).
    // Reset to 0 on any successful response. A transient Vite restart or
    // network hiccup no longer strands the tab with stale buttons: the loop
    // Audit Finding 1: the transient-failure backoff state machine
    // (consecutive counter + backoff index + give-up threshold) is shared with
    // the TOP_MEAN reattach loop via ReattachBackoffController. The cancellable
    // timer fields stay per-loop because the two loops express ownership
    // and healthy-poll cadence differently.
    private readonly reattachBackoff = new ReattachBackoffController();

    constructor(deps: {
        getDom: () => BatchBacktestDom;
        resultsView: BatchResultsView;
        onBusyStateChange?: () => void;
        isUiBusy: () => boolean;
        balancedLock: () => { blocked: boolean; hasResult: boolean };
        getPairListProvenance: () => PairListProvenanceV1 | null;
        requestServerStop: () => Promise<void>;
    }) {
        this.deps = deps;
    }

    // ── Facade-visible state (cross-workflow gates + regression suite) ──

    /** Current monotonic run token (results-view render authorization). */
    currentRunToken(): number {
        return this.runToken;
    }

    getRunInFlight(): boolean {
        return this.runInFlight;
    }

    setRunInFlight(value: boolean): void {
        this.runInFlight = value;
    }

    getLastResults(): BatchBacktestSymbolResult[] {
        return this.lastResults;
    }

    setLastResults(results: BatchBacktestSymbolResult[]): void {
        this.lastResults = results;
    }

    getLastRunFingerprint(): string | null {
        return this.lastRunFingerprint;
    }

    setLastRunFingerprint(fingerprint: string | null): void {
        this.lastRunFingerprint = fingerprint;
    }

    getLastRunInterval(): string | null {
        return this.lastRunInterval;
    }

    setLastRunInterval(interval: string | null): void {
        this.lastRunInterval = interval;
    }

    getServerHasArtifacts(): boolean {
        return this.serverHasArtifacts;
    }

    setServerHasArtifacts(value: boolean): void {
        this.serverHasArtifacts = value;
    }

    getActiveServerRunId(): string | null {
        return this.activeServerRunId;
    }

    setActiveServerRunId(runId: string | null): void {
        this.activeServerRunId = runId;
    }

    setServerRunActive(value: boolean): void {
        this.serverRunActive = value;
    }

    isServerRunActive(): boolean {
        return this.serverRunActive;
    }

    /** Batch-owned terms of the facade's cross-workflow busy gate. */
    isBusy(): boolean {
        return this.runInFlight || this.serverRunActive || this.reattachTimer !== null;
    }

    // ── Sort display state (presentation tied to the results list) ──────

    toggleBatchResultSort(dom: BatchBacktestDom, key: BatchResultSortKey): void {
        this.cancelLiveRenderRaf();
        this.deps.resultsView.dropQueuedRows();
        if (!this.batchResultSort || this.batchResultSort.key !== key) {
            this.batchResultSort = { key, direction: "desc" };
        } else if (this.batchResultSort.direction === "desc") {
            this.batchResultSort = { key, direction: "asc" };
        } else {
            this.batchResultSort = null;
        }
        this.renderResultRows(dom);
        this.updateBatchResultSortHeader(dom);
    }

    resetSort(dom: BatchBacktestDom): void {
        this.cancelLiveRenderRaf();
        this.deps.resultsView.dropQueuedRows();
        this.batchResultSort = null;
        this.renderResultRows(dom);
        this.updateBatchResultSortHeader(dom);
    }

    /** Re-render only the sort header state (init/restore paths). */
    refreshSortHeader(dom: BatchBacktestDom): void {
        this.updateBatchResultSortHeader(dom);
    }

    private updateBatchResultSortHeader(dom: BatchBacktestDom): void {
        this.deps.resultsView.updateBatchResultSortHeader(dom, this.batchResultSort);
    }

    // ── Presentation wrappers over the results view ─────────────────────

    setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        this.lastProgressPercent = percent;
        this.deps.resultsView.setProgress(dom, percent, text);
    }

    setRunBusy(dom: BatchBacktestDom, busy: boolean): void {
        this.deps.resultsView.setRunBusy(dom, busy, this.deps.balancedLock());
        this.deps.onBusyStateChange?.();
    }

    /**
     * Re-assert ONLY the balanced-generator buttons from the current lock
     * state, without touching the rest of the busy presentation. Lifecycle
     * transitions that clear their owner flag AFTER a setRunBusy/render
     * baked the buttons disabled (run finally ordering, analysis finish,
     * Stop settling, reattach run-mismatch) call this so the buttons unlock
     * instead of staying disabled until the next full busy render.
     */
    updateBalancedGeneratorButtons(dom: BatchBacktestDom): void {
        this.deps.resultsView.updateBalancedGeneratorButtons(dom, this.deps.balancedLock());
    }

    updateSummary(dom: BatchBacktestDom): void {
        this.deps.resultsView.updateSummary(dom, this.lastResults);
    }

    renderSummaryGrid(dom: BatchBacktestDom): void {
        this.deps.resultsView.renderSummaryGrid(dom, this.lastResults);
    }

    resetProgress(dom: BatchBacktestDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.batchBacktestStatus.textContent = "Idle";
        this.setRunBusy(dom, false);
    }

    private queueLiveRender(dom: BatchBacktestDom, result: BatchBacktestSymbolResult, token: number): void {
        this.deps.resultsView.queueLiveRender(
            dom,
            result,
            token,
            this.batchResultSort ? () => this.renderResultRows(dom) : undefined,
        );
    }

    private flushLiveRenderNow(dom: BatchBacktestDom, token: number): void {
        this.deps.resultsView.flushLiveRenderNow(
            dom,
            token,
            this.batchResultSort ? () => this.renderResultRows(dom) : undefined,
        );
    }

    cancelLiveRenderRaf(): void {
        this.deps.resultsView.cancelLiveRenderRaf();
    }

    private appendResultRows(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void {
        this.deps.resultsView.appendResultRows(dom, results);
    }

    private renderResultRows(dom: BatchBacktestDom): void {
        this.deps.resultsView.renderResultRows(dom, this.lastResults, this.batchResultSort);
        this.appendedCount = this.lastResults.length;
    }

    // ── Run lifecycle ───────────────────────────────────────────────────

    public async runBatch(): Promise<void> {
        if (this.disposed) return;
        // Audit single-flight finding: this guard fires BEFORE any await and
        // before the Run button is disabled, so a rapid double-click on Run
        // cannot stack two invocations that both pass local preflight. The
        // button-disable further down stays as the visual signal; this is the
        // correctness gate. Also blocks when TOP_MEAN / analysis / reattach
        // owns the UI so Stop and completion handlers stay coherent.
        if (this.deps.isUiBusy()) {
            const dom = this.deps.getDom();
            dom.batchBacktestStatus.textContent = "Batch is already running — wait for it to finish.";
            return;
        }
        this.runInFlight = true;
        try {
            await this.runBatchInner();
        } finally {
            this.runInFlight = false;
            // The inner finally restored Run/Stop while this controller's
            // runInFlight was still held, so the balanced-generator buttons
            // were rendered from a still-blocked lock and stayed disabled
            // after the run. Re-assert them now that the flags are down.
            if (!this.disposed) this.updateBalancedGeneratorButtons(this.deps.getDom());
        }
    }

    private async runBatchInner(): Promise<void> {
        const dom = this.deps.getDom();
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
        if (this.disposed) return;
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
        const runFingerprint = buildBatchRunFingerprint({
            symbols,
            strategyKey,
            strategyParams,
            backtestSettings,
            capitalSettings,
            interval,
            pairListProvenance: this.deps.getPairListProvenance(),
        });

        // Invalidate any in-flight run and claim this one. The stale run will
        // see its token mismatch after its next await and stop mutating state.
        this.runToken += 1;
        const token = this.runToken;
        // Finding 6: a previous run's pending live-render RAF must not fire
        // against this new run's freshly-cleared results list.
        this.cancelLiveRenderRaf();
        this.deps.resultsView.dropQueuedRows();
        this.cancelled = false;
        this.lastResults = [];
        this.batchResultSort = null;
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
        dom.batchBacktestCopyOpenPositionsBtn.disabled = true;
        dom.batchBacktestCopyBenchmarkBtn.disabled = true;
        this.setRunBusy(dom, true);
        this.setProgress(dom, 0, "Starting");
        this.clearStaleRows(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        // Batch has one execution path: the Vite dev server streams scalar
        // rows while retaining heavy analysis artifacts outside the browser tab.
        // Reset the prior run's server cache stats so they can't leak into the
        // next run's benchmark if the `done` event never arrives (cancel /
        // crash). `recordRunBenchmark` re-populates this from the `done` event
        // or the recovery/reattach path.
        this.pendingServerRunCacheStats = null;
        this.pendingServerRunCounts = null;
        this.pendingServerRunPerformance = null;
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
                dom.batchBacktestCopyOpenPositionsBtn.disabled = this.lastResults.length === 0;
                // In server-side mode the artifacts stay on the server; the
                // OPEN_SCORE USD button must be gated on the `serverHasArtifacts`
                // flag (set by the `done` event), not on `row.data !== undefined`
                // (the browser never holds `row.data` in this mode).
                this.updateArtifactActionButtons(dom);
                this.updateSummary(dom);
                const completed = reachedTerminal && runOutcome === "done";
                const progressLabel = completed ? "Done" : runOutcome === "cancelled" ? "Stopped" : "Failed";
                this.setProgress(dom, completed ? 100 : this.lastProgressPercent, progressLabel);
                this.setRunBusy(dom, false);
                // Audit benchmark-rows finding: record the benchmark only after
                // a known terminal outcome. A run that exited via HTTP/stream
                // failure without recovery is recorded as `incomplete` (still
                // observable, but clearly labeled). `this.cancelled` from the
                // user clicking Stop is a terminal outcome (`cancelled`).
                const benchmarkOutcome: BatchBenchmarkRunOutcome = reachedTerminal
                    ? runOutcome
                    : "incomplete";
                this.recordRunBenchmark(strategyKey, interval, runStartedAt, benchmarkOutcome);
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
    public async runBatchServer(
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
        // so the server can scope Stop to THIS run. Adopted on the controller
        // so Stop and reattach reconciliation send the same value.
        const runId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        if (token === this.runToken) {
            this.activeServerRunId = runId;
            this.serverRunActive = true;
            this.persistActiveServerRun(runId);
        }
        const response = await fetch("/api/batch-backtest/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: this.controlAbort.signal,
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
                ...(this.deps.getPairListProvenance()
                    ? { pairListProvenance: this.deps.getPairListProvenance() }
                    : {}),
            }),
        });
        if (token !== this.runToken) {
            await response.body?.cancel();
            return;
        }
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
                    this.pendingServerRunCounts = {
                        attempted: event.totals.attemptedSymbols ?? this.lastResults.length,
                        cancelled: event.totals.cancelledSymbols ?? 0,
                        failed: event.totals.failedSymbols,
                    };
                    this.pendingServerRunPerformance = event.performance ?? null;
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
            this.deps.resultsView.dropQueuedRows();
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

    public async drainStatusRows(
        dom: BatchBacktestDom,
        initial: BatchStatusRowsPage,
        scopeRunId: string | undefined,
        pageKey: "run" | "lastRun",
        options: {
            limit: number;
            maxRows: number;
            stopWhenPollingStopped?: boolean;
        },
    ): Promise<void> {
        this.reconcileStatusRows(dom, initial.rows, initial.rowOffset, scopeRunId);

        const limit = Math.max(1, Math.floor(options.limit));
        const maxRows = Math.max(0, Math.floor(options.maxRows));
        const maxPages = Math.max(0, Math.ceil(maxRows / limit) + 1);
        let cursor = initial.nextOffset ?? null;
        let previousCursor: number | null = null;

        for (
            let pageCount = 0;
            typeof cursor === "number"
            && this.lastResults.length < maxRows
            && pageCount < maxPages;
            pageCount += 1
        ) {
            if (options.stopWhenPollingStopped && this.reattachPollingStopped) return;
            if (!Number.isFinite(cursor) || (previousCursor !== null && cursor <= previousCursor)) return;
            previousCursor = cursor;

            const scopeQuery = scopeRunId ? `&runId=${encodeURIComponent(scopeRunId)}` : "";
            const payload = await requestBatchControl(
                `/api/batch-backtest/status?after=${cursor}&limit=${limit}${scopeQuery}`,
                { cache: "no-store" },
                async (response) => response.ok ? parseJsonPreservingNonFinite(await response.text()) : null,
                { signal: options.stopWhenPollingStopped ? this.reattachAbort?.signal : this.controlAbort.signal },
            ) as {
                runMismatch?: boolean;
                run?: BatchStatusRowsPage | null;
                lastRun?: BatchStatusRowsPage | null;
            } | null;
            if (!payload) return;
            if (options.stopWhenPollingStopped && this.reattachPollingStopped) return;
            if (payload.runMismatch) return;
            const page = pageKey === "run" ? payload.run : payload.lastRun;
            if (!page || !Array.isArray(page.rows) || page.rows.length === 0) return;

            this.reconcileStatusRows(dom, page.rows, page.rowOffset, scopeRunId);
            const nextCursor = page.nextOffset === undefined ? null : page.nextOffset;
            if (nextCursor !== null && (!Number.isFinite(nextCursor) || nextCursor <= cursor)) return;
            cursor = nextCursor;
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
            const firstPayload = await requestBatchControl(
                scopeRunId
                    ? `/api/batch-backtest/status?runId=${encodeURIComponent(scopeRunId)}`
                    : "/api/batch-backtest/status",
                { cache: "no-store" },
                async (response) => response.ok ? response.json() : null,
                { signal: this.controlAbort.signal },
            ) as {
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
            } | null;
            if (this.disposed || !firstPayload) return null;
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
            await this.drainStatusRows(
                dom,
                {
                    rows: lastRun.rows,
                    rowOffset: lastRun.rowOffset,
                    nextOffset: lastRun.nextOffset,
                },
                scopeRunId,
                "lastRun",
                {
                    limit: PAGE_LIMIT,
                    maxRows: Math.min(
                        MAX_ROWS_TO_RECONSTRUCT,
                        Math.max(serverRowCount, lastRun.rows?.length ?? 0),
                    ),
                },
            );

            if (this.disposed) return null;
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
    public reconcileStatusRows(
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
        if (this.batchResultSort) {
            this.renderResultRows(dom);
        } else {
            this.appendResultRows(dom, accepted);
        }
        return accepted;
    }

    // ── Benchmark capture. Each phase records wall clock + cache stats; the
    // Copy Benchmark button pretty-prints the accumulated snapshot to the
    // clipboard as JSON (mirrors Finder's Copy Diagnostics).

    private recordRunBenchmark(
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
        const serverCounts = this.pendingServerRunCounts;
        const attempted = serverCounts?.attempted ?? this.lastResults.length;
        if (serverCounts) {
            failed = serverCounts.failed;
            cancelled = serverCounts.cancelled;
            completed = Math.max(0, attempted - failed);
        }
        const phase: BatchBenchmarkRunPhase = {
            totalMs,
            ...(this.pendingServerRunPerformance ?? {}),
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
        const cacheSource = this.pendingServerRunCacheStats ? "server_stream" : "unavailable";
        const cache = this.pendingServerRunCacheStats ?? this.emptyCacheStats();
        const snapshot: BatchBenchmarkSnapshot = {
            schema: BATCH_BENCHMARK_SCHEMA,
            run: {
                mode: "server",
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
        const dom = this.deps.getDom();
        dom.batchBacktestCopyBenchmarkBtn.disabled = false;
    }

    private emptyCacheStats(): BatchBenchmarkCacheStats {
        return buildCacheStatsFromLoader({
            leg: { hits: 0, misses: 0, size: 0, max: 24 },
            pair: { hits: 0, misses: 0, size: 0, max: 16 },
            disk: { hits: 0, misses: 0, writes: 0 },
        });
    }

    public async copyBenchmarkPerformance(): Promise<void> {
        if (!this.lastBenchmark) {
            uiManager.showToast("No benchmark to copy", "info");
            return;
        }
        const text = JSON.stringify(this.lastBenchmark, null, 2);
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast("Benchmark copied", "success");
        } else {
            this.deps.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    public async copyResults(reportLines: readonly string[]): Promise<void> {
        if (this.lastResults.length === 0) return;
        const lines = formatBatchOverallSummary(this.lastResults);
        // Include the completed OPEN_SCORE USD selector study in the main
        // Batch copy so MAX_ACTIVE and its controls are not lost when the user
        // uses Copy Results instead of the analysis-specific copy button.
        if (reportLines.length) {
            lines.push("", ...reportLines);
        }
        const text = lines.join("\n");
        const copied = await copyToClipboard(text);
        if (!copied) {
            this.deps.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * Copy Open Positions: the pair symbols whose position was still open at
     * the end of the run, one per line (paste-ready into the Pairs textarea).
     * The server stream carries the tiny `openPosition` scalar per row because
     * `result.trades` never reaches the browser (see `toScalarRow`).
     */
    public async copyOpenPositionPairs(): Promise<void> {
        if (this.lastResults.length === 0) return;
        const pairs = collectOpenPositionSymbols(this.lastResults);
        if (pairs.length === 0) {
            uiManager.showToast("No open positions in the latest run", "info");
            return;
        }
        const copied = await copyToClipboard(pairs.join("\n"));
        if (copied) {
            uiManager.showToast(`Copied ${pairs.length} pair${pairs.length === 1 ? "" : "s"} with open positions`, "success");
        } else {
            this.deps.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    // ── Stop plumbing ───────────────────────────────────────────────────

    /** Local Cancel flag for the active Batch run (Stop button). */
    requestLocalCancel(): void {
        this.cancelled = true;
    }

    /** Cancel the Batch run and any analysis holding the server analysis lock. */
    public async stopServerWork(): Promise<void> {
        if (this.disposed) return;
        try {
            // Audit Finding 5: send the active run id so the server scopes
            // Stop to THIS run. A stale tab's mismatched id is rejected
            // without mutating the active run's ownership.
            const runId = this.activeServerRunId;
            const { ok, payload } = await requestBatchControl("/api/batch-backtest/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(runId ? { runId } : {}),
            }, async (response) => ({
                ok: response.ok,
                payload: await response.json().catch(() => null) as { ok?: boolean } | null,
            }), { signal: this.controlAbort.signal });
            if (!this.disposed && ok && payload?.ok && runId) this.clearActiveServerRun(runId);
        } catch (error) {
            debugLogger.warn("batch.server.stop_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** Clear the local run-cancel flag at the start of each analysis. */
    resetLocalCancel(): void {
        this.cancelled = false;
    }

    private stopReattachPoll(): void {
        this.reattachPollingStopped = true;
        this.reattachAbort?.abort();
        this.reattachAbort = null;
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer);
            this.reattachTimer = null;
        }
        if (this.reattachTimerResolve) {
            this.reattachTimerResolve();
            this.reattachTimerResolve = null;
        }
    }

    // ── Persistence ─────────────────────────────────────────────────────

    public loadPersistedLatestResults(dom: BatchBacktestDom): void {
        const snapshot = readLatestResultsSnapshot();
        if (!snapshot) return;

        this.lastResults = snapshot.results;
        this.batchResultSort = null;
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
        this.renderResultRows(dom);
        setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
        dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
        dom.batchBacktestCopyOpenPositionsBtn.disabled = this.lastResults.length === 0;
        // Audit Mine-Prediction-gating finding: route every artifact-action
        // button (Mine, Stability, OPEN_SCORE USD) through the same helper so
        // a tab that reloads into restored-but-not-current state keeps all
        // three disabled consistently until a server-side run re-enables them.
        this.updateArtifactActionButtons(dom);
        // Audit Finding 5: if the snapshot was truncated to fit the localStorage
        // quota, label the restored table "N of M pairs" so the user knows a
        // reload did not recover the full run (server reattach still can).
        const totalRows = snapshot.meta?.truncated ? snapshot.meta.totalRows : this.lastResults.length;
        dom.batchBacktestStatus.textContent = snapshot.meta?.truncated
            ? `Restored last Batch run (${this.lastResults.length} of ${totalRows} pairs — truncated to fit local cache)`
            : `Restored last Batch run (${this.lastResults.length} pairs)`;
        this.setProgress(dom, 100, "Restored");
        this.renderSummaryGrid(dom);
        debugLogger.event("batch_backtest.latest_results_restored", {
            count: this.lastResults.length,
            interval: this.lastRunInterval,
            savedAt: snapshot.savedAt,
        });
    }

    public saveLatestResultsSnapshot(): void {
        saveLatestResultsSnapshot({
            results: this.lastResults,
            interval: this.lastRunInterval ?? state.currentInterval,
            fingerprint: this.lastRunFingerprint,
            strategyKey: this.lastRunStrategyKey,
            serverHasArtifacts: this.serverHasArtifacts,
        });
    }

    public clearPersistedLatestResults(): void {
        clearPersistedLatestResults();
    }

    public persistActiveServerRun(runId: string): void {
        persistActiveServerRun(runId);
    }

    public loadPersistedActiveServerRun(): BatchPersistedActiveServerRun | null {
        return loadPersistedActiveServerRun();
    }

    public clearActiveServerRun(expectedRunId?: string, clearMemory = true): void {
        if (expectedRunId && this.activeServerRunId && this.activeServerRunId !== expectedRunId) return;
        if (clearMemory) {
            this.stopReattachPoll();
            this.activeServerRunId = null;
            this.serverRunActive = false;
        }
        clearPersistedActiveServerRun();
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
    public updateArtifactActionButtons(dom: BatchBacktestDom): void {
        const available = this.serverHasArtifacts && Boolean(this.lastRunFingerprint);
        dom.batchBacktestOpenScoreUsdBtn.disabled = !available;
    }

    /**
     * Batch-owned half of the facade's clearStaleResults: drop derived run
     * state and rendered rows so a new pair list cannot reuse a prior run's
     * fingerprints, artifacts, or output.
     */
    public clearStaleRows(dom: BatchBacktestDom): void {
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.lastRunStrategyKey = null;
        this.serverHasArtifacts = false;
        this.batchResultSort = null;
        this.updateBatchResultSortHeader(dom);
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
        dom.batchBacktestCopyOpenPositionsBtn.disabled = true;
    }

    // ── Reattach polling ────────────────────────────────────────────────

    /**
     * Polls `GET /api/batch-backtest/status` on init. If a run is in flight on
     * the server (started before this tab opened), renders the snapshot rows
     * accumulated so far and long-polls every 2s until the run ends, then
     * renders the final summary. Mirrors IBKR sync's reattach pattern.
     *
     * Polling is unbounded: a 1000-pair server-side run can outlast the prior
     * 5-minute cap, which stranded the UI while Node kept working. Lifetime is
     * gated by the server's `running` flag, `stopReattachPoll()` (Stop button /
     * dispose / a new Run), and a 2s→5s step-down after 5 minutes to shed idle
     * load on very long runs. Transient failures ride the shared
     * ReattachBackoffController (2s → 5s → 10s → 15s, then a 60s cadence).
     */
    public async reattachToInProgressServerRun(): Promise<void> {
        if (this.disposed) return;
        const POLL_INTERVAL_MS = 2000;
        const LONG_POLL_INTERVAL_MS = 5000;
        const FAST_POLL_COUNT = 150; // 5 minutes at 2s before stepping down to 5s.
        // Audit Finding 1: the consecutive-failure backoff + give-up threshold
        // live in the shared ReattachBackoffController (reattach-backoff.ts).
        this.reattachPollingStopped = false;
        this.reattachAbort = new AbortController();
        this.reattachBackoff.reset();
        // A persisted run id means this tab already owns a reattach window;
        // scope the initial busy UI to that case. With no id, the first poll is
        // intentionally unscoped and may discover another tab's active run.
        if (this.activeServerRunId) {
            const reattachDom = this.deps.getDom();
            reattachDom.batchBacktestRunBtn.disabled = true;
            setVisible(reattachDom.batchBacktestStopBtn, true);
            this.setRunBusy(reattachDom, true);
        }
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
                // Audit Finding 7: the `/api/batch-backtest/status` shape is
                // now the shared `BatchStatusResponse` contract, locked
                // against the producer (`handleStatusRequest`) by a contract
                // test. Previously this was an inline anonymous type that
                // drifted from the producer.
                let payload: BatchStatusResponse;
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
                    payload = await requestBatchControl(
                        `/api/batch-backtest/status?after=${this.lastResults.length}${initialRunId}`,
                        { cache: "no-store" },
                        async (response) => {
                            if (!response.ok) throw new Error(`status ${response.status}`);
                            return parseJsonPreservingNonFinite(await response.text()) as BatchStatusResponse;
                        },
                        { signal: this.reattachAbort.signal },
                    );
                    // Audit runId-scoping finding: server confirmed the retained
                    // run is no longer ours. Stop polling without adopting another
                    // tab's snapshot. Keep the already-rendered rows in place.
                    if (payload.runMismatch) {
                        if (!this.reattachPollingStopped) {
                            const dom = this.deps.getDom();
                            dom.batchBacktestRunBtn.disabled = false;
                            setVisible(dom.batchBacktestStopBtn, false);
                            this.setRunBusy(dom, false);
                            this.updateSummary(dom);
                            dom.batchBacktestStatus.textContent = "Batch run was replaced by a newer run — click Run to start over.";
                        }
                        // A mismatch is authoritative server-side loss/replacement;
                        // clear this tab's persisted ownership after restoring the
                        // controls so a reload does not retry a dead run id.
                        const staleRunId = this.activeServerRunId;
                        if (staleRunId) this.clearActiveServerRun(staleRunId);
                        // setRunBusy(false) above rendered the buttons while
                        // serverRunActive was still true; clearActiveServerRun
                        // then dropped the flag without a re-render.
                        if (!this.reattachPollingStopped) {
                            this.updateBalancedGeneratorButtons(this.deps.getDom());
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
                            const dom = this.deps.getDom();
                            await this.drainStatusRows(
                                dom,
                                payload.lastRun,
                                terminalRunId,
                                "lastRun",
                                {
                                    limit: 250,
                                    maxRows: Math.min(10_000, payload.lastRun.rowCount ?? payload.lastRun.rows?.length ?? 0),
                                    stopWhenPollingStopped: true,
                                },
                            );
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
                            this.deps.getDom().batchBacktestStatus.textContent =
                                `Server Batch failed: ${payload.lastRun.error ?? payload.lastRun.summary ?? "Unknown error"}`;
                        } else if (payload.lastRun?.summary) {
                            this.deps.getDom().batchBacktestStatus.textContent = payload.lastRun.summary;
                        }
                        this.serverRunActive = false;
                        if (terminalRunId) this.clearActiveServerRun(terminalRunId, false);
                        // Only restore Run/Stop/busy if reattach is still the active
                        // task. A user clicking Run while this fetch was in-flight
                        // calls stopReattachPoll(); in that case the user's Run owns
                        // the button/busy state now and we must not clobber it. The
                        // loop-top check does not cover the await above, so guard
                        // the DOM writes explicitly.
                        if (!this.reattachPollingStopped) {
                            const dom = this.deps.getDom();
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
                    const dom = this.deps.getDom();
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
                    // so any page boundary is safe. Paged responses are scoped to
                    // the active run id so a newer run started mid-drain cannot
                    // contaminate this tab's row list.
                    await this.drainStatusRows(
                        dom,
                        run,
                        this.activeServerRunId ?? undefined,
                        "run",
                        {
                            limit: 250,
                            maxRows: run.rowCount,
                            stopWhenPollingStopped: true,
                        },
                    );
                    // `run.completed` already counts every attempted (non-skipped)
                    // row, including failures — adding `run.failed` double-counts
                    // them and lets progress exceed the total (e.g. 11/10). The
                    // server sets `snapshot.completed = attemptedSymbols`, where
                    // attemptedSymbols = successes + failures (audit Finding 4).
                    if (this.reattachPollingStopped) return;
                    this.reattachBackoff.recordSuccess();
                    const seen = run.completed;
                    const current = run.currentSymbol ? ` — ${run.currentSymbol}` : "";
                    const label = `Server run ${seen}/${run.total}${current}`;
                    dom.batchBacktestStatus.textContent = label;
                    // Capture for the transient-failure branch so the
                    // "connection interrupted" message can keep the last known
                    // progress visible.
                    lastRunLabel = label;
                    this.setProgress(dom, run.total > 0 ? (seen / run.total) * 100 : 0, `${seen}/${run.total}`);
                    const delay = poll < FAST_POLL_COUNT ? POLL_INTERVAL_MS : LONG_POLL_INTERVAL_MS;
                    await new Promise<void>((resolve) => {
                        this.reattachTimerResolve = resolve;
                        this.reattachTimer = setTimeout(resolve, delay);
                    });
                    this.reattachTimer = null;
                    this.reattachTimerResolve = null;
                } catch (error) {
                    if (this.reattachPollingStopped) return;
                    const outcome = this.reattachBackoff.recordFailure();
                    debugLogger.warn("batch.server.reattach_poll_failed", {
                        consecutive: outcome.consecutive,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    if (outcome.gaveUp) {
                        if (!this.activeServerRunId) {
                            // This was an unscoped discovery poll, not a
                            // persisted ownership window. Leave normal Batch
                            // actions available rather than polling forever.
                            this.deps.getDom().batchBacktestStatus.textContent
                                = "Server connection unavailable; click Run to retry.";
                            return;
                        }
                        // Do not clear ownership after a transient outage: the
                        // server may still be executing and Stop must remain
                        // available. Reset the bounded counter and retry at a
                        // low cadence until status recovers or runId mismatches.
                        this.reattachBackoff.reset();
                        this.deps.getDom().batchBacktestStatus.textContent
                            = "Server connection lost — retrying status in 60s. Stop remains available.";
                        await new Promise<void>((resolve) => {
                            this.reattachTimerResolve = resolve;
                            this.reattachTimer = setTimeout(resolve, 60_000);
                        });
                        this.reattachTimer = null;
                        this.reattachTimerResolve = null;
                        poll -= 1;
                        continue;
                    }
                    // Keep the last known progress visible alongside the
                    // interrupted warning so the user can see the run is
                    // (probably) still alive on the server.
                    const prior = lastRunLabel ? ` (${lastRunLabel})` : "";
                    this.deps.getDom().batchBacktestStatus.textContent
                        = `Server connection interrupted${prior} — retrying (${outcome.consecutive}/${outcome.max})`;
                    await new Promise<void>((resolve) => {
                        this.reattachTimerResolve = resolve;
                        this.reattachTimer = setTimeout(resolve, outcome.backoffDelayMs);
                    });
                    this.reattachTimer = null;
                    this.reattachTimerResolve = null;
                    // Don't advance `poll` into the long-poll step-down just
                    // because of retries — backoff already shed load.
                    poll -= 1;
                    continue;
                }
            }
        } catch (error) {
            debugLogger.warn("batch.server.reattach_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.stopReattachPoll();
        }
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.runToken += 1;
        this.controlAbort.abort();
        this.stopReattachPoll();
        this.cancelLiveRenderRaf();
        this.deps.resultsView.dropQueuedRows();
    }
}
