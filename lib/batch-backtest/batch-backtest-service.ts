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
import {
    readBatchAutoRunStability,
    shouldAutoRunBatchStability,
    writeBatchAutoRunStability,
} from "./batch-auto-stability-preference";
import { getBatchDatasetCacheStats } from "./batch-backtest-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { extractBatchServerError, postBatchNdjson } from "./batch-ndjson-post";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { buildBatchRunFingerprint, parseBatchSymbols, BATCH_MAX_SYMBOLS } from "./batch-run-contract";
import { generateBalancedPairList, type BalancedPairListResult, type PairListProvenanceV1 } from "./balanced-pair-list-generator";
import { fnv1a64Hex } from "./max-active-research-contract";
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
    type BatchBenchmarkRunOutcome,
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
import type { OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";
import type { OpenScoreUsdReplayStreamEvent } from "./batch-open-score-usd-replay-stream-types";
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
    private lastMinerResult: BatchSyntheticMinerResult | null = null;
    private lastStabilityResult: BatchStabilityMineResult | null = null;
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
    // Audit single-flight finding: closes the double-click window between the
    // user's click and the Run button being disabled (which happens ~50 lines
    // into runBatch, after the first awaits). Without this guard, a rapid
    // double-click stacks two runBatch() invocations on the event loop before
    // either can disable the button — both pass the local preflight and the
    // second one steals ownership from the first.
    private runInFlight = false;
    // Browser-generated server run id (audit Finding 5). Sent on the /run body
    // and the /stop body so the server can scope Stop to THIS run: a stale tab
    // cannot cancel a newer run. Reattach also matches this against the
    // terminal snapshot's runId to decide whether to adopt the recovered run.
    private activeServerRunId: string | null = null;
    private serverRunActive = false;
    // Serializes Mine Timing, Stability, and OPEN_SCORE USD Replay.
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
    // Mine verdict live-render queue (separate from the run-row queue above).
    // The server-streamed Mine path emits one `verdict` event per asset; the
    // NDJSON consumer drains every line in a tight `while` with no `await`
    // between handlers, so a single `reader.read()` returning many verdicts
    // fires many synchronous `appendChild`s. Queue verdicts and flush once per
    // animation frame (same pattern as the run-row queue) so a 200-asset Mine
    // produces one reflow per frame instead of 200.
    private minerVerdictQueue: BatchSyntheticAssetVerdict[] = [];
    private minerVerdictRafId: number | null = null;
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

    private latestTopMeanResult: any = null;
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
        dom.batchBacktestAutoRunStability.checked = readBatchAutoRunStability();
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
            // Fast path: when there is nothing derived from a prior run/cache
            // to invalidate (no fingerprint, no live results, no miner/stability
            // results, no active server run, no provenance to recheck), the
            // input event only needs the pair-count summary text. Skipping the
            // heavy path here avoids two `parseBatchSymbols` passes + a
            // `localStorage.removeItem` per keystroke while editing/pasting
            // large pair lists.
            const hasDerivedState = this.lastRunFingerprint !== null
                || this.lastResults.length > 0
                || this.lastMinerResult !== null
                || this.lastStabilityResult !== null
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

    private async runBatch(): Promise<void> {
        // Audit single-flight finding: this guard fires BEFORE any await and
        // before the Run button is disabled, so a rapid double-click on Run
        // cannot stack two invocations that both pass local preflight. The
        // button-disable further down stays as the visual signal; this is the
        // correctness gate.
        if (this.runInFlight) {
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
                // Mine button must be gated on the `serverHasArtifacts` flag
                // (set by the `done` event), not on `row.data !== undefined`
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
                    // but not all Mine artifacts (disk pressure on a 1000-pair
                    // run). Keep the Mine button enabled as long as any artifact
                    // survived — Mine still works on the survivors.
                    if (event.artifactStats && event.artifactStats.failed > 0) {
                        const { stored, eligible, failed } = event.artifactStats;
                        const base = doneSummary ?? `Done — ${this.lastResults.length} pairs`;
                        doneSummary = `${base} — artifacts ${stored}/${eligible}; Mine will omit ${failed} failed write${failed === 1 ? "" : "s"}.`;
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
                const decision = computeStabilityAction(row, this.lastStabilityResult!.reruns, interval);
                return (decision.action === "ENTER" || decision.action === "WATCH")
                    && decision.dataLagBars !== null
                    && decision.dataLagBars <= STABILITY_DATA_STALE_THRESHOLD_BARS;
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
            const verdicts: BatchSyntheticAssetVerdict[] = [];
            // Defensive: reset the verdict render queue + cancel any stale RAF
            // so a previous Mine's pending render cannot leak into this run.
            // The onStart handler replaces `replaceChildren()` on the DOM side.
            this.cancelMinerVerdictRaf();
            this.minerVerdictQueue = [];
            const minerInterval = this.lastRunInterval ?? state.currentInterval;
            // Audit NDJSON-POST-helper finding: route through the shared
            // `postBatchNdjson` helper for the transport mechanics (fetch,
            // response validation, JSON error extraction, requireTerminal).
            // The handler object stays at the call site so the typed Mine
            // events (`start`/`verdict`/`done`/`fatal`) stay compile-checked.
            // `onResponse` preserves the prior ordering: re-issue Stop AFTER
            // the POST establishes server-side ownership so a Stop that raced
            // the POST is re-sent once the lock is held.
            await postBatchNdjson<BatchMinerStreamEvent>({
                endpoint: "/api/batch-backtest/mine",
                body: {
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval,
                },
                onResponse: () => this.reissueStopIfNeeded(),
                handlers: {
                    onStart: (event: Extract<BatchMinerStreamEvent, { type: "start" }>) => {
                        targetCount = Math.max(0, Math.floor(event.assets ?? 0));
                        dom.batchBacktestMinerSummary.textContent = `Mining on server — ${event.assets} assets / ${event.pairs} pairs`;
                    },
                    onVerdict: (event: Extract<BatchMinerStreamEvent, { type: "verdict" }>) => {
                        // Push to `verdicts` synchronously so the post-Mine
                        // Copy/persist path sees the complete, ordered list. The
                        // DOM row is queued and rendered once per animation
                        // frame (mirrors the run-row `queueLiveRender` path) to
                        // avoid one layout-invalidating append per verdict on a
                        // fast stream (Finding 7 in the perf-audit list).
                        verdicts.push(event.verdict);
                        this.queueMinerVerdictRender(dom, event.verdict);
                    },
                    onDone: (event: Extract<BatchMinerStreamEvent, { type: "done" }>) => {
                        dom.batchBacktestMinerSummary.textContent = event.summary;
                    },
                    onFatal: (event: Extract<BatchMinerStreamEvent, { type: "fatal" }>) => {
                        throw new Error(event.error);
                    },
                },
            });
            this.lastMinerResult = {
                interval: minerInterval,
                options: BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
                verdicts,
                diagnostics: [],
            };
            // Drain any queued verdict rows synchronously so the final count is
            // visible before the summary text and Copy button state update.
            this.cancelMinerVerdictRaf();
            this.flushMinerVerdictRenderNow(dom);
            dom.batchBacktestMinerSummary.textContent = formatMinerSummary(this.lastMinerResult);
            dom.batchBacktestCopyMinerBtn.disabled = verdicts.length === 0;
            this.persistMineTimingResult("mine");
            // Server has released its artifacts; Mine cannot run again until a
            // new server-side Run produces them.
            this.serverHasArtifacts = false;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Drop any queued verdict rows: the partial Mine result is being
            // discarded. Without this the RAF callback would render stale
            // verdicts after `lastMinerResult` was cleared.
            this.cancelMinerVerdictRaf();
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.server_failed", { error: message });
        } finally {
            this.updateArtifactActionButtons(dom);
        }
        return targetCount;
    }

    /** Cancel the Batch run and any analysis holding the server miner lock. */
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
                        // prior run (the tab reloaded), but server-side Mine
                        // and Stability Mine can still consume retained
                        // artifacts before their TTL expires.
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
                this.updateArtifactActionButtons(dom);
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


        try {
            const received: { result: BatchStabilityMineResult | null; cancelledSummary: string | null } = {
                result: null,
                cancelledSummary: null,
            };
            // Audit NDJSON-POST-helper finding: shared transport. The
            // `onNonOkResponse` hook preserves the prior 400 "no artifacts"
            // special case so the next click short-circuits without a second
            // round trip. `onResponse` preserves the reissue-Stop ordering.
            await postBatchNdjson<BatchStabilityMineStreamEvent>({
                endpoint: "/api/batch-backtest/stability-mine",
                body: {
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval ?? state.currentInterval,
                    subsetSize,
                    reruns,
                    seed,
                },
                onResponse: () => this.reissueStopIfNeeded(),
                onNonOkResponse: (status, payload) => {
                    if (status === 400 && typeof payload?.error === "string" && payload.error.includes("no artifacts on server")) {
                        this.serverHasArtifacts = false;
                    }
                },
                handlers: {
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
            this.updateArtifactActionButtons(dom);
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

    /**
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
        const maxPairs = this.readClampedInt(dom.batchBacktestBalancedMaxPairs.value, BATCH_MAX_SYMBOLS, 1, BATCH_MAX_SYMBOLS);
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
            // Phase 3 MAX_ACTIVE: thread the active pair-list provenance into
            // the fingerprint so a manual textarea edit (which clears the
            // provenance) also changes the fingerprint and invalidates
            // retained artifacts. This mirrors the server-side fingerprint
            // construction in processRunBatch.
            this.activePairListProvenance,
            state.currentInterval
        );
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
        // Audit Mine-Prediction-gating finding: route every artifact-action
        // button (Mine, Stability, OPEN_SCORE USD) through the same helper so
        // a tab that reloads into restored-but-not-current state keeps all
        // three disabled consistently until a server-side run re-enables them.
        this.updateArtifactActionButtons(dom);
        if (this.lastStabilityResult) {
            this.renderStabilityResult(dom, this.lastStabilityResult);
            dom.batchBacktestCopyStabilityBtn.disabled = this.lastStabilityResult.rows.length === 0;
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
     * Single source of truth for the three artifact-action buttons (Mine,
     * Stability Mine, OPEN_SCORE USD). Audit finding (artifact-action gating):
     * an artifact-only button used to stay enabled after `clearStaleResults`
     * invalidated the fingerprint (only Mine and Stability were disabled), so
     * the user could click a stale button and only then see "Run Batch first."
     * Locking all three artifact-dependent buttons to the same
     * `serverHasArtifacts && lastRunFingerprint` gate keeps them consistent
     * across every lifecycle branch.
     */
    private updateArtifactActionButtons(dom: BatchBacktestDom): void {
        const available = this.serverHasArtifacts && Boolean(this.lastRunFingerprint);
        dom.batchBacktestMineBtn.disabled = !available;
        dom.batchBacktestStabilityMineBtn.disabled = !available;
        dom.batchBacktestOpenScoreUsdBtn.disabled = !available;
    }

    private updateBalancedGeneratorButtons(dom: BatchBacktestDom): void {
        const blocked = this.runInFlight || this.analysisInFlight
            || this.pendingStopPromise !== null || this.serverRunActive;
        dom.batchBacktestBalancedGenerateBtn.disabled = blocked;
        dom.batchBacktestBalancedCopyBtn.disabled = blocked || !this.lastBalancedPairListResult;
    }

    private clearMinerResults(dom: BatchBacktestDom): void {
        this.lastMinerResult = null;
        this.lastStabilityResult = null;
        this.lastOpenScoreUsdResult = null;
        // Clear rather than show "Miner idle": an empty .batch-miner-status
        // collapses via CSS (:empty) so the run-state region does not show a
        // noise strip before any mining has happened (point 7 of the refactor).
        dom.batchBacktestMinerSummary.textContent = "";
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdSummary.textContent = "";
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
     * stale when the underlying data exceeds the freshness threshold. The pipe
     * formatter stays for clipboard / Copy Stability output.
     */
    private createStabilityRow(
        row: BatchStabilityRow,
        decision: StabilityActionDecision,
        reruns: number,
    ): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "batch-miner-row";
        const hasUntrustedDataAge = decision.dataLagBars === null
            || decision.dataLagBars > STABILITY_DATA_STALE_THRESHOLD_BARS;
        if (hasUntrustedDataAge) line.classList.add("is-stale");

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
     * Mine-verdict live-render counterpart to {@link queueLiveRender}. Verdicts
     * arrive faster than a frame each on a warm stream; queue them and append
     * in one DocumentFragment per frame so a 200-asset Mine produces one
     * reflow per frame instead of 200. A synchronous flush fires at
     * `LIVE_RENDER_MAX_BATCH` so very fast cached streams don't defer visible
     * progress too long.
     */
    private queueMinerVerdictRender(dom: BatchBacktestDom, verdict: BatchSyntheticAssetVerdict): void {
        this.minerVerdictQueue.push(verdict);
        if (this.minerVerdictQueue.length >= LIVE_RENDER_MAX_BATCH) {
            this.flushMinerVerdictRenderNow(dom);
            return;
        }
        if (this.minerVerdictRafId !== null) return;
        this.minerVerdictRafId = requestAnimationFrame(() => {
            this.minerVerdictRafId = null;
            this.flushMinerVerdictRenderNow(dom);
        });
    }

    /**
     * Drain the Mine verdict queue as a single DocumentFragment append
     * (preserves verdict order). Called on the RAF schedule and on terminal
     * paths.
     */
    private flushMinerVerdictRenderNow(dom: BatchBacktestDom): void {
        if (this.minerVerdictQueue.length === 0) return;
        const batch = this.minerVerdictQueue;
        this.minerVerdictQueue = [];
        const fragment = document.createDocumentFragment();
        for (const verdict of batch) {
            fragment.appendChild(this.createMinerRow(verdict));
        }
        dom.batchBacktestMinerResults.appendChild(fragment);
    }

    /**
     * Cancel any pending Mine-verdict RAF and drop the queue. Called on the
     * Mine error path so a stale RAF does not render partial verdicts after
     * `lastMinerResult` was cleared.
     */
    private cancelMinerVerdictRaf(): void {
        if (this.minerVerdictRafId !== null) {
            cancelAnimationFrame(this.minerVerdictRafId);
            this.minerVerdictRafId = null;
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
        // Audit Finding 5: a stale run id must not survive a results clear.
        this.activeServerRunId = null;
        this.clearPersistedLatestResults();
        // Audit artifact-action-gating finding: all three artifact-action
        // buttons share the same gate; clearing stale results disables Mine,
        // Stability, AND OPEN_SCORE USD consistently through one helper.
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
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
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
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
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
                        const c = event.counts;
                        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML =
                            `<strong>Universe Coverage:</strong> <strong>${c.pairCount} pairs</strong> | ` +
                            `${c.usableTargetIntervalCount} target-usable assets | ` +
                            `${c.sp500AssetsCount} total assets cataloged | ` +
                            `${c.excludedAssetsCount} excluded assets`;
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
            this.recordTopMeanDiagnostic("run.error", {
                name: err instanceof Error ? err.name : typeof err,
                message,
                stack: err instanceof Error ? err.stack : undefined,
            });
            dom.batchBacktestSp500TopMeanProgressText.textContent = `Status: ${message}`;
        } finally {
            setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
            setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
            this.recordTopMeanDiagnostic("ui.finally", {
                runButtonDisplay: dom.batchBacktestSp500TopMeanRunBtn.style.display,
                stopButtonDisplay: dom.batchBacktestSp500TopMeanStopBtn.style.display,
                activeRunId: this.activeTopMeanRunId,
                progressText: dom.batchBacktestSp500TopMeanProgressText.textContent,
            });
        }
    }

    public async stopSp500TopMeanCoordinator(): Promise<void> {
        const runId = this.activeTopMeanRunId;
        if (!runId) {
            this.recordTopMeanDiagnostic("stop.ignored", { reason: "no active run id" });
            return;
        }
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

        // 1. Leaderboard Banner: Executive summary of top asset per horizon
        html += `<div style="background: var(--surface-2, #1e222d); border: 1px solid var(--border-color, #2a2e39); border-radius: 6px; padding: 12px; margin-bottom: 16px;">`;
        html += `<div style="font-weight: bold; font-size: 14px; margin-bottom: 8px; color: var(--accent-color, #2962ff);">🏆 TOP_MEAN Asset Leaderboard</div>`;
        html += `<div style="display: flex; gap: 16px; flex-wrap: wrap;">`;

        for (const h of summary.horizons) {
            const top = Array.isArray(h.topAssets) && h.topAssets.length > 0 ? h.topAssets[0] : null;
            if (top) {
                const sharePct = (top.share * 100).toFixed(1) + "%";
                html += `<div style="flex: 1; min-width: 180px; background: var(--surface-1, #131722); padding: 8px 12px; border-radius: 4px; border-left: 3px solid #26a69a;">`;
                html += `<div style="font-size: 11px; color: var(--text-dim, #787b86); text-transform: uppercase;">Horizon ${h.horizon} Bars</div>`;
                html += `<div style="font-size: 16px; font-weight: bold; margin: 2px 0;">${top.asset}</div>`;
                html += `<div style="font-size: 12px; color: var(--text-color, #d1d4dc);">${top.events?.toLocaleString()} events (${sharePct} share)</div>`;
                html += `<div style="font-size: 11px; color: ${(top.delta ?? 0) >= 0 ? '#26a69a' : '#ef5350'}; margin-top: 2px;">Delta: ${formatSignedPercent(top.delta)}</div>`;
                html += `</div>`;
            }
        }
        html += `</div></div>`;

        // 2. Detailed horizon tables with rank #1 badge
        for (const h of summary.horizons) {
            html += `<div style="margin-top: 16px; font-weight: bold; font-size: 13px;">`;
            html += `Horizon ${h.horizon} bars | ${h.events?.toLocaleString()} decision events | `;
            html += `TOP_MEAN: top=${formatSignedPercent(h.topMean?.topMean)} random=${formatSignedPercent(h.topMean?.randomMean)} delta=${formatSignedPercent(h.topMean?.delta)}`;
            html += `</div>`;

            html += `<table class="finder-table" style="width:100%; margin-top:6px; font-size:12px;">`;
            html += `<thead><tr><th>Rank</th><th>Asset</th><th>Events</th><th>Share</th><th>Selected Mean</th><th>Control Mean</th><th>Delta</th></tr></thead><tbody>`;

            let rank = 1;
            for (const row of h.topAssets || []) {
                const sharePct = (row.share * 100).toFixed(1) + "%";
                const isTop = rank === 1;
                html += `<tr style="${isTop ? 'background: rgba(38, 166, 154, 0.1); font-weight: 600;' : ''}">`;
                html += `<td>${isTop ? '🥇 1' : rank}</td>`;
                html += `<td><strong>${row.asset}</strong> ${isTop ? '<span style="font-size:10px; background:#26a69a; color:#fff; padding:1px 4px; border-radius:3px; margin-left:4px;">TOP</span>' : ''}</td>`;
                html += `<td>${row.events?.toLocaleString()}</td>`;
                html += `<td>${sharePct}</td>`;
                html += `<td>${formatSignedPercent(row.topMean)}</td>`;
                html += `<td>${formatSignedPercent(row.randomMean)}</td>`;
                html += `<td>${formatSignedPercent(row.delta)}</td>`;
                html += `</tr>`;
                rank++;
            }
            html += `</tbody></table>`;
        }
        dom.batchBacktestSp500TopMeanResults.innerHTML = html;
    }

    public async copySp500TopMeanResults(): Promise<void> {
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

        if (Array.isArray(res.horizons)) {
            for (const h of res.horizons) {
                lines.push(`--- Horizon ${h.horizon} Bars (${h.events?.toLocaleString()} decision events) ---`);
                lines.push(`TOP_MEAN Overall: top=${formatSignedPercent(h.topMean?.topMean)} rand=${formatSignedPercent(h.topMean?.randomMean)} delta=${formatSignedPercent(h.topMean?.delta)}`);
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
        this.activeTopMeanRunId = persisted.runId;
        this.topMeanDiagnosticRunId = persisted.runId;
        this.recordTopMeanDiagnostic("reattach.start", { runId: persisted.runId });
        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);

        const runId = persisted.runId;
        const pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`/api/batch-backtest/sp500-top-mean/status?runId=${runId}`);
                this.recordTopMeanDiagnostic("reattach.response", {
                    runId,
                    status: res.status,
                    ok: res.ok,
                });
                if (!res.ok) {
                    clearInterval(pollInterval);
                    setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                    setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
                    return;
                }
                const status = await res.json();
                this.recordTopMeanDiagnostic("reattach.status", status);
                dom.batchBacktestSp500TopMeanProgressText.textContent = `[${status.phase}] ${status.progressText}`;

                if (status.status === "completed" || status.status === "failed" || status.status === "interrupted") {
                    clearInterval(pollInterval);
                    setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                    setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
                    if (status.result) {
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
                }
            } catch (err) {
                this.recordTopMeanDiagnostic("reattach.error", {
                    runId,
                    name: err instanceof Error ? err.name : typeof err,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }, 2000);
    }
}

/** Stable, display-only FNV-1a digest; the full fingerprint remains in state. */
function shortFingerprint(value: string | null): string {
    if (!value) return "--";
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
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
