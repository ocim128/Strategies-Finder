/**
 * TOP_MEAN workflow owner: the coordinator run/stop/reattach lifecycle, the
 * durable diagnostic ring, and the result/copy/download actions for the
 * TOP_MEAN panel.
 *
 * Owns its mutable run state (active run id, reattach timers/backoff,
 * diagnostic ring + debounces, latest result, selected arm). Presentation is
 * delegated to the browser view modules; persistence to the browser store.
 * Cross-workflow locks (batchActionInFlight, isBatchUiBusy) stay with the
 * facade — the facade claims them around `run()` so rapid clicks cannot stack
 * coordinator POSTs.
 */
import { backtestService } from "../../backtest-service";
import { shouldUseRustEngine } from "../../engine-preferences";
import { paramManager } from "../../param-manager";
import { state } from "../../state";
import { strategyRegistry } from "../../../strategyRegistry";
import { setVisible } from "../../dom-utils";
import { debugLogger } from "../../debug-logger";
import { copyToClipboard } from "../../browser-transfer";
import { postBatchNdjson } from "../batch-ndjson-post";
import { parseTopMeanMenuHorizons, parseTopMeanMenuOptionalPositiveInt } from "../sp500-top-mean-request-limits";
import {
    approxJsonByteLength,
    clearTopMeanDiagnosticLog,
    compactTopMeanDiagnosticData,
    readTopMeanDiagnosticLogSnapshot,
    sampleTopMeanHeap,
    writeTopMeanDiagnosticLogSnapshot,
    type TopMeanDiagnosticEntry,
} from "../sp500-top-mean-diagnostic-log";
import { formatTopMeanPerformanceLines } from "../sp500-top-mean-performance";
import { ReattachBackoffController } from "../reattach-backoff";
import type { TopMeanCurrentSnapshot, TopMeanStreamEvent } from "../sp500-top-mean-stream-types";
import type { CoverageCounts } from "../sp500-pair-enumerator";
import type { TopMeanResultSummary, TopMeanStatusResponse } from "../sp500-top-mean-coordinator-engine";
import type {
    OpenScoreUsdEventDetailSelector,
    OpenScoreUsdLatestSelections,
    OpenScoreUsdLatestSelectorName,
} from "../open-score-replay/types";
import { isActiveCapTiltWeight } from "../cap-tilt-contract";
import { debounce } from "../../debounce";
import { escapeHtml } from "../../html-escape";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import {
    clearPersistedLatestTopMeanResult,
    clearTopMeanActiveRun,
    persistLatestTopMeanResult,
    persistTopMeanActiveRun,
    readLatestTopMeanResult,
    readTopMeanActiveRun,
} from "./batch-browser-store";
import {
    formatCurrentTopMeanLines,
    formatLatestOpenScoreSelectionLines,
    formatTopMeanCompletionMessage,
    mergeTopMeanArchiveStatus,
    normalizeLatestArm,
    renderCurrentTopMeanBanner,
    renderTopMeanResults as renderTopMeanResultsView,
} from "./top-mean-results-view";
import {
    buildOngoingEventDetails,
    getTopMeanOpenScoreDetailSelector,
    getTopMeanOpenScoreDetailYear,
    renderTopMeanOpenScoreEventDetails,
    resetTopMeanOpenScoreDetails,
    syncTopMeanOpenScoreDetailsControl,
} from "./top-mean-event-details-view";

export class TopMeanController {
    private readonly getDom: () => BatchBacktestDom;
    /** DOM read that must not force-create the tab DOM (pre-init reads). */
    private readonly peekDom: () => BatchBacktestDom | null;
    private latestTopMeanResult: TopMeanResultSummary | null = null;
    /** Arm shown in the Latest OPEN_SCORE Selector Picks card (one at a time). */
    private latestOpenScoreArm: OpenScoreUsdLatestSelectorName = "TOP_MEAN";
    private activeTopMeanRunId: string | null = null;
    private topMeanDiagnosticRunId: string | null = null;
    private topMeanDiagnosticEntries: TopMeanDiagnosticEntry[] = [];
    private topMeanDiagnosticProgressSeen = 0;
    // The diagnostic panel is a debugging surface — the per-event DOM rewrite
    // previously ran `JSON.stringify` over the ENTIRE accumulated entries
    // array on every NDJSON event, turning a multi-hour run into O(N²) string
    // work. Bound the retained history and coalesce the DOM updates.
    private static readonly TOP_MEAN_DIAGNOSTIC_MAX_ENTRIES = 500;
    private static readonly TOP_MEAN_DIAGNOSTIC_RENDER_DEBOUNCE_MS = 250;
    private readonly renderTopMeanDiagnosticDebounced = debounce(() => {
        const dom = this.peekDom();
        if (!dom) return;
        dom.batchBacktestSp500TopMeanDiagnostic.textContent = this.buildTopMeanDiagnosticText();
    }, TopMeanController.TOP_MEAN_DIAGNOSTIC_RENDER_DEBOUNCE_MS);
    // Crash-safety: the in-memory ring dies with the tab, and the failure mode
    // under investigation is a tab-killing OOM. Progress bursts persist on a
    // debounce; every lifecycle event (run.start, ndjson.done, ndjson.fatal,
    // run.error, stop.*, reattach.*) persists immediately — see
    // recordTopMeanDiagnostic — so the log survives a crash or reload.
    private static readonly TOP_MEAN_DIAGNOSTIC_PERSIST_DEBOUNCE_MS = 1_500;
    private readonly persistTopMeanDiagnosticDebounced = debounce(() => {
        this.writeTopMeanDiagnosticLogNow();
    }, TopMeanController.TOP_MEAN_DIAGNOSTIC_PERSIST_DEBOUNCE_MS);
    /** True while the TOP_MEAN reattach serial poll loop owns the UI. */
    private topMeanReattachInFlight = false;
    private topMeanReattachTimer: ReturnType<typeof setTimeout> | null = null;
    private topMeanReattachTimerResolve: (() => void) | null = null;
    // Audit Finding 1: shared transient-failure backoff state machine.
    private readonly topMeanReattachBackoff = new ReattachBackoffController();

    constructor(deps: { getDom: () => BatchBacktestDom; peekDom: () => BatchBacktestDom | null }) {
        this.getDom = deps.getDom;
        this.peekDom = deps.peekDom;
    }

    // ── Facade-facing state (cross-workflow busy gate + tests) ──────────

    getActiveTopMeanRunId(): string | null {
        return this.activeTopMeanRunId;
    }

    setActiveTopMeanRunId(runId: string | null): void {
        this.activeTopMeanRunId = runId;
    }

    getLatestTopMeanResult(): TopMeanResultSummary | null {
        return this.latestTopMeanResult;
    }

    setLatestTopMeanResult(result: TopMeanResultSummary | null): void {
        this.latestTopMeanResult = result;
    }

    /** True while a run id or the reattach poll loop should block other Batch actions. */
    isUiOwned(): boolean {
        return this.activeTopMeanRunId !== null || this.topMeanReattachInFlight;
    }

    getLatestArm(): OpenScoreUsdLatestSelectorName {
        return this.latestOpenScoreArm;
    }

    setLatestArm(value: string | null | undefined): void {
        this.latestOpenScoreArm = normalizeLatestArm(value);
    }

    getDiagnosticEntries(): TopMeanDiagnosticEntry[] {
        return this.topMeanDiagnosticEntries;
    }

    getDiagnosticRunId(): string | null {
        return this.topMeanDiagnosticRunId;
    }

    setDiagnosticRunId(runId: string | null): void {
        this.topMeanDiagnosticRunId = runId;
    }

    /**
     * TOP_MEAN Coordinator tie-break mode from the TIE BREAK select.
     *   off    - ties stay unresolved (TIE / SKIP), the historical default.
     *   alpha  - the alphabetically-first tied asset is picked.
     *   random - a seeded-random tied asset is picked, stable per event so
     *            re-renders and copied output always agree.
     */
    topMeanTieBreakMode(): "off" | "alpha" | "random" {
        const value = this.peekDom()?.batchBacktestSp500TopMeanTieBreak?.value;
        return value === "alpha" || value === "random" ? value : "off";
    }

    // ── Run lifecycle ───────────────────────────────────────────────────

    /**
     * Audit Finding 6: the coordinator preflight parsers share the strategy
     * gate, the workerCount/maxPairs integer parse, and the runId generation.
     * The strategy gate itself is injected per run by the facade (which owns
     * the cross-workflow preflight seam).
     */
    private generateTopMeanRunId(): string {
        return `sp500_top_mean_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    }

    /** Called by the facade's single-flight wrapper (shared lock held there). */
    public async run(args: {
        resolveStrategy: (dom: BatchBacktestDom) => Promise<{
            strategyKey: string;
            strategy: NonNullable<ReturnType<typeof strategyRegistry.get>>;
        } | undefined>;
    }): Promise<void> {
        const dom = this.getDom();
        const resolved = await args.resolveStrategy(dom);
        if (!resolved) return;
        const { strategyKey, strategy } = resolved;

        // Audit (menu-numeric finding): strict input parsing. "0"/"12.5"/"abc"
        // in Workers or Max Pairs used to fall through to "not set" — silently
        // launching the auto-worker or full-universe workload — and invalid
        // horizon tokens were silently dropped while valid ones remained.
        const horizonsParsed = parseTopMeanMenuHorizons(dom.batchBacktestSp500TopMeanHorizons.value);
        if (horizonsParsed.kind === "invalid") {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                `Error: Invalid horizons value "${horizonsParsed.token}". Use comma-separated positive integers, e.g. 12,24,48.`;
            return;
        }
        const horizons = horizonsParsed.horizons;

        const workersParsed = parseTopMeanMenuOptionalPositiveInt(dom.batchBacktestSp500TopMeanWorkers.value);
        if (workersParsed.kind === "invalid") {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Workers must be a positive whole number, or blank for automatic.";
            return;
        }
        const maxPairsParsed = parseTopMeanMenuOptionalPositiveInt(dom.batchBacktestSp500TopMeanMaxPairs.value);
        if (maxPairsParsed.kind === "invalid") {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Max Pairs must be a positive whole number, or blank for the full universe.";
            return;
        }
        const workerCount = workersParsed.kind === "valid" ? workersParsed.value : undefined;
        const maxPairs = maxPairsParsed.kind === "valid" ? maxPairsParsed.value : undefined;

        const runId = this.generateTopMeanRunId();
        this.activeTopMeanRunId = runId;
        this.topMeanDiagnosticRunId = runId;
        this.topMeanDiagnosticEntries = [];
        this.topMeanDiagnosticProgressSeen = 0;
        // A new run starts a fresh durable log. The previous run's evidence
        // was copyable up to this point (Copy Diagnostic after a reload); from
        // here the new run's timeline replaces it.
        clearTopMeanDiagnosticLog((error) => debugLogger.warn("sp500_top_mean.diagnostic_log_clear_failed", {
            error: error instanceof Error ? error.message : String(error),
        }));
        this.latestTopMeanResult = null;
        this.clearPersistedLatestTopMeanResult();
        persistTopMeanActiveRun(runId);

        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, true);
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled = true;
        this.resetTopMeanOpenScoreDetails(dom);
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;

        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML = "";
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Starting TOP_MEAN coordinator...";
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
        const saveArchiveLog = dom.batchBacktestSp500TopMeanArchiveToggle.checked;
        // Coordinator-owned cap-tilt weighting (docs/open-score-cap-tilt.md
        // Phase 5) — independent of the standalone OPEN_SCORE USD section's
        // select. "off" is omitted from the payload so baseline requests stay
        // byte-identical to the pre-Phase-5 shape.
        const capTiltWeight = dom.batchBacktestSp500TopMeanCapTilt.value;

        const payload = {
            runId,
            strategyKey,
            strategyParams: paramManager.getValues(strategy),
            backtestSettings: backtestService.getBacktestSettings(),
            capitalSettings: backtestService.getCapitalSettings(),
            interval: pairListText ? state.currentInterval : "4h",
            horizons,
            workerCount,
            maxPairs,
            pairListText,
            saveArchiveLog,
            useRustEnginePreference: shouldUseRustEngine(),
            ...(sampleFrom ? { sampleFrom } : {}),
            ...(sampleTo ? { sampleTo } : {}),
            ...(isActiveCapTiltWeight(capTiltWeight) ? { capTiltWeight } : {}),
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
            await postBatchNdjson<TopMeanStreamEvent>({
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
                onEvent: (event) => {
                    this.recordTopMeanNdjsonEvent(event);
                },
                handlers: {
                    onPreflight: (event: Extract<TopMeanStreamEvent, { type: "preflight" }>) => {
                        this.renderTopMeanCoverageSummary(dom, event.counts);
                    },
                    onProgress: (event: Extract<TopMeanStreamEvent, { type: "progress" }>) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent = `[${event.phase}] ${event.text}`;
                    },
                    onCurrentSnapshot: (event: Extract<TopMeanStreamEvent, { type: "current_snapshot" }>) => {
                        // The algorithmic decision is complete before the slower
                        // historical replay. Surface it immediately after the
                        // current-snapshot phase instead of making the user wait
                        // for the terminal leaderboard.
                        dom.batchBacktestSp500TopMeanResults.innerHTML =
                            this.renderCurrentTopMeanBanner(event.currentSnapshot);
                    },
                    onDone: (event: Extract<TopMeanStreamEvent, { type: "done" }>) => {
                        if ("interrupted" in event) {
                            this.latestTopMeanResult = null;
                            dom.batchBacktestSp500TopMeanCopyBtn.disabled = true;
                            dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled = true;
                            this.resetTopMeanOpenScoreDetails(dom);
                            dom.batchBacktestSp500TopMeanDownloadBtn.disabled = true;
                            dom.batchBacktestSp500TopMeanProgressText.textContent = "TOP_MEAN run stopped.";
                            this.activeTopMeanRunId = null;
                            clearTopMeanActiveRun();
                            return;
                        }
                        this.latestTopMeanResult = event.result;
                        this.persistLatestTopMeanResult(event.result);
                        this.renderTopMeanResults(dom, event.result);
                        dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled =
                            !Array.isArray(event.result.reportLines) || event.result.reportLines.length === 0;
                        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        dom.batchBacktestSp500TopMeanProgressText.textContent =
                            formatTopMeanCompletionMessage(event.result);
                        this.activeTopMeanRunId = null;
                        clearTopMeanActiveRun();
                    },
                    onFatal: (event: Extract<TopMeanStreamEvent, { type: "fatal" }>) => {
                        dom.batchBacktestSp500TopMeanProgressText.textContent = `Error: ${event.error}`;
                        this.activeTopMeanRunId = null;
                        clearTopMeanActiveRun();
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

    /** Safe coverage summary — all numeric counts, no untrusted strings. */
    private renderTopMeanCoverageSummary(dom: BatchBacktestDom, counts: CoverageCounts): void {
        const c = counts;
        dom.batchBacktestSp500TopMeanCoverageSummary.innerHTML =
            `<strong>Universe Coverage:</strong> <strong>${escapeHtml(c.pairCount)} pairs</strong> | ` +
            `${escapeHtml(c.usableTargetIntervalCount)} target-usable assets | ` +
            `${escapeHtml(c.sp500AssetsCount)} total assets cataloged | ` +
            `${escapeHtml(c.excludedAssetsCount)} excluded assets`;
    }

    public async stop(): Promise<void> {
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
            const body = await response.text().catch(() => "");
            this.recordTopMeanDiagnostic("stop.response", {
                runId,
                status: response.status,
                ok: response.ok,
                body,
            });
            let stopped: boolean | null = null;
            try {
                const parsed = JSON.parse(body) as { stopped?: unknown };
                stopped = typeof parsed.stopped === "boolean" ? parsed.stopped : null;
            } catch {
                // A non-JSON response is treated as a failed stop response.
            }
            if (!response.ok || stopped !== true) {
                this.clearTopMeanRunAfterServerLoss(
                    this.getDom(),
                    "TOP_MEAN run is no longer active; local run state cleared.",
                );
            }
        } catch (err) {
            this.recordTopMeanDiagnostic("stop.error", {
                runId,
                name: err instanceof Error ? err.name : typeof err,
                message: err instanceof Error ? err.message : String(err),
            });
            this.clearTopMeanRunAfterServerLoss(
                this.getDom(),
                "TOP_MEAN server is unavailable; local run state cleared.",
            );
        }
    }

    private clearTopMeanRunAfterServerLoss(dom: BatchBacktestDom, message: string): void {
        this.activeTopMeanRunId = null;
        clearTopMeanActiveRun();
        setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
        setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
        dom.batchBacktestSp500TopMeanProgressText.textContent = message;
    }

    // ── Results rendering / persistence / details ───────────────────────

    public renderTopMeanResults(dom: BatchBacktestDom, summary: TopMeanResultSummary): void {
        renderTopMeanResultsView(dom, summary, {
            latestArm: this.latestOpenScoreArm,
            tieMode: this.topMeanTieBreakMode(),
        });
        this.syncTopMeanOpenScoreDetailsControl(dom, summary);
    }

    public persistLatestTopMeanResult(result: TopMeanResultSummary): void {
        persistLatestTopMeanResult(result);
    }

    public clearPersistedLatestTopMeanResult(): void {
        clearPersistedLatestTopMeanResult();
    }

    public loadPersistedLatestTopMeanResult(dom: BatchBacktestDom): void {
        const result = readLatestTopMeanResult();
        if (!result) return;

        this.latestTopMeanResult = result;
        this.renderTopMeanResults(dom, result);
        dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled =
            !Array.isArray(result.reportLines) || result.reportLines.length === 0;
        dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
        dom.batchBacktestSp500TopMeanProgressText.textContent = formatTopMeanCompletionMessage(result);
    }

    public resetTopMeanOpenScoreDetails(dom: BatchBacktestDom): void {
        resetTopMeanOpenScoreDetails(dom);
    }

    public syncTopMeanOpenScoreDetailsControl(
        dom: BatchBacktestDom,
        summary: TopMeanResultSummary,
    ): void {
        syncTopMeanOpenScoreDetailsControl(dom, summary);
    }

    public toggleSp500TopMeanOpenScoreDetails(): void {
        const dom = this.getDom();
        if (!this.latestTopMeanResult || dom.batchBacktestSp500TopMeanDetailsBtn.disabled) {
            return;
        }
        const show = dom.batchBacktestSp500TopMeanDetails.hidden;
        dom.batchBacktestSp500TopMeanDetails.hidden = !show;
        dom.batchBacktestSp500TopMeanDetailsBtn.textContent = show
            ? "Hide OPEN_SCORE Details"
            : "Show OPEN_SCORE Details";
        if (show && !dom.batchBacktestSp500TopMeanDetails.innerHTML) {
            // Recorded (and persisted) BEFORE rendering: if the details table
            // render is what kills the tab, the log must already say so.
            this.recordTopMeanDiagnostic("ui.details_render.start", {
                selector: this.getTopMeanOpenScoreDetailSelector(dom),
                fullWindowRows: this.latestTopMeanResult.openScoreEventDetails?.length ?? 0,
                annualSections: this.latestTopMeanResult.annualReports?.length ?? 0,
            });
            dom.batchBacktestSp500TopMeanDetails.innerHTML =
                this.renderTopMeanOpenScoreEventDetails(
                    this.latestTopMeanResult,
                    this.getTopMeanOpenScoreDetailSelector(dom),
                    this.getTopMeanOpenScoreDetailYear(dom),
                );
            this.recordTopMeanDiagnostic("ui.details_render.done", {
                htmlChars: dom.batchBacktestSp500TopMeanDetails.innerHTML.length,
            });
        }
    }

    public getTopMeanOpenScoreDetailSelector(
        dom: BatchBacktestDom,
    ): OpenScoreUsdEventDetailSelector {
        return getTopMeanOpenScoreDetailSelector(dom);
    }

    /** Selected calendar year for the details table; null = full window. */
    public getTopMeanOpenScoreDetailYear(dom: BatchBacktestDom): number | null {
        return getTopMeanOpenScoreDetailYear(dom);
    }

    public renderTopMeanOpenScoreEventDetails(
        summary: TopMeanResultSummary,
        selector: OpenScoreUsdEventDetailSelector,
        year: number | null = null,
    ): string {
        return renderTopMeanOpenScoreEventDetails(summary, selector, year);
    }

    public buildOngoingEventDetails(summary: TopMeanResultSummary) {
        return buildOngoingEventDetails(summary);
    }

    public renderCurrentTopMeanBanner(currentSnapshot: TopMeanCurrentSnapshot): string {
        return renderCurrentTopMeanBanner(currentSnapshot, this.topMeanTieBreakMode());
    }

    /**
     * Phase-1 current snapshot lines for the Copy Results output. Mirrors the
     * banner content in plain text so the clipboard surface matches the UI.
     */
    public formatCurrentTopMeanLines(currentSnapshot: any): string[] {
        return formatCurrentTopMeanLines(currentSnapshot, this.topMeanTieBreakMode());
    }

    public formatLatestOpenScoreSelectionLines(latestInput: OpenScoreUsdLatestSelections): string[] {
        return formatLatestOpenScoreSelectionLines(latestInput, this.topMeanTieBreakMode());
    }

    // ── Copy / download ─────────────────────────────────────────────────

    public async copySp500TopMeanResults(): Promise<void> {
        if (!this.latestTopMeanResult) return;
        this.recordTopMeanDiagnostic("ui.copy_result.start", {});
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
        if (res.latestSelections) {
            lines.push(...this.formatLatestOpenScoreSelectionLines(res.latestSelections));
        }
        if (res.performance) {
            lines.push(...formatTopMeanPerformanceLines(res.performance), "");
        }

        if (Array.isArray(res.horizons)) {
            for (const h of res.horizons) {
                lines.push(`--- HISTORICAL TOP_MEAN | Horizon ${h.horizon} Bars (${h.events?.toLocaleString()} decision events) ---`);
                lines.push(`HISTORICAL TOP_MEAN | horizon=${h.horizon} | top=${formatSignedPercent(h.topMean?.topMean)} rand=${formatSignedPercent(h.topMean?.randomMean)} deltaMed=${formatSignedPercent(h.topMean?.delta)}`);
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

    public async copySp500TopMeanOpenScoreResults(): Promise<void> {
        const text = this.buildTopMeanOpenScoreText();
        if (!text) return;
        this.recordTopMeanDiagnostic("ui.copy_open_score.start", { textChars: text.length });
        const copied = await copyToClipboard(text);
        const dom = this.getDom();
        dom.batchBacktestSp500TopMeanProgressText.textContent = copied
            ? "Copied TOP_MEAN OPEN_SCORE report to clipboard."
            : "Copy OPEN_SCORE failed.";
    }

    public buildTopMeanOpenScoreText(): string {
        const lines = this.latestTopMeanResult?.reportLines;
        return Array.isArray(lines) ? lines.join("\n") : "";
    }

    public async copySp500TopMeanDiagnostic(): Promise<void> {
        const text = this.buildTopMeanDiagnosticText();
        this.recordTopMeanDiagnostic("ui.copy_diagnostic", {
            textChars: text.length,
            entries: this.topMeanDiagnosticEntries.length,
        });
        await copyToClipboard(text);
        const dom = this.getDom();
        dom.batchBacktestSp500TopMeanProgressText.textContent = "Copied TOP_MEAN diagnostic to clipboard.";
    }

    public downloadSp500TopMeanResults(): void {
        if (!this.latestTopMeanResult) return;
        const text = JSON.stringify(this.latestTopMeanResult, null, 2);
        this.recordTopMeanDiagnostic("ui.download_result", { jsonChars: text.length });
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sp500_top_mean_${this.latestTopMeanResult.runId || "result"}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── Diagnostic ring ─────────────────────────────────────────────────

    public buildTopMeanDiagnosticText(): string {
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

    public recordTopMeanNdjsonEvent(event: any): void {
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
        // The approximate wire size of each event is the primary OOM evidence:
        // it shows exactly which payload stressed the tab, and by how much.
        this.recordTopMeanDiagnostic(`ndjson.${event?.type || "unknown"}`, event, approxJsonByteLength(event));
    }

    public recordTopMeanDiagnostic(type: string, data?: unknown, bytes?: number): void {
        // Compact AT RECORD TIME: the ring must never retain multi-MB payload
        // duplicates (a terminal reattach poll carries the whole wire-safe
        // result). The diagnostic evidence is the timeline, the byte size,
        // and the shape — full payloads live in Copy Result / Copy OPEN_SCORE.
        const entry: TopMeanDiagnosticEntry = {
            at: new Date().toISOString(),
            type,
            data: compactTopMeanDiagnosticData(data),
        };
        const heap = sampleTopMeanHeap();
        if (heap) entry.heap = heap;
        if (typeof bytes === "number" && Number.isFinite(bytes)) entry.bytes = bytes;
        this.topMeanDiagnosticEntries.push(entry);
        // Bound the retained history so a multi-hour run does not accumulate
        // unbounded entries (each reattach poll previously appended a full
        // /status payload). Ring-buffer: drop the oldest once over cap.
        if (this.topMeanDiagnosticEntries.length > TopMeanController.TOP_MEAN_DIAGNOSTIC_MAX_ENTRIES) {
            this.topMeanDiagnosticEntries.shift();
        }
        const dom = this.peekDom();
        if (dom) {
            dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.disabled = false;
            dom.batchBacktestSp500TopMeanDiagnostic.hidden = false;
            // Coalesce rapid bursts (progress + per-window + reattach polls) into
            // one DOM write per debounce window. The Copy button always reads the
            // current array via `buildTopMeanDiagnosticText()`, so no data is lost.
            this.renderTopMeanDiagnosticDebounced();
        }
        // Persist the ring so the log survives the tab dying. Progress events
        // are the only high-frequency type and ride the debounce; everything
        // else (run.start, ndjson.done/fatal, run.error, stop.*, reattach.*)
        // is rare and written through immediately.
        if (type === "ndjson.progress") {
            this.persistTopMeanDiagnosticDebounced();
        } else {
            this.writeTopMeanDiagnosticLogNow();
        }
    }

    public writeTopMeanDiagnosticLogNow(): void {
        writeTopMeanDiagnosticLogSnapshot(
            this.topMeanDiagnosticRunId,
            this.topMeanDiagnosticEntries,
            (error) => debugLogger.warn("sp500_top_mean.diagnostic_log_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        );
    }

    /**
     * Adopt the diagnostic log persisted by a previous session so Copy
     * Diagnostic works after a reload — the expected flow after an OOM crash
     * killed the tab. Live entries (an in-flight run) always win.
     */
    public restorePersistedTopMeanDiagnostics(): void {
        if (this.topMeanDiagnosticEntries.length > 0) return;
        const snapshot = readTopMeanDiagnosticLogSnapshot();
        if (!snapshot || snapshot.entries.length === 0) return;
        this.topMeanDiagnosticRunId = snapshot.runId;
        this.topMeanDiagnosticEntries = snapshot.entries;
        this.recordTopMeanDiagnostic("diagnostic.restored_from_previous_session", {
            runId: snapshot.runId,
            savedAt: snapshot.savedAt,
            restoredEntries: snapshot.entries.length,
        });
        const dom = this.peekDom();
        if (dom) {
            dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.disabled = false;
            dom.batchBacktestSp500TopMeanDiagnostic.hidden = false;
            dom.batchBacktestSp500TopMeanDiagnostic.textContent = this.buildTopMeanDiagnosticText();
        }
    }

    // ── Reattach ────────────────────────────────────────────────────────

    public async reattachToInProgressTopMeanRun(): Promise<void> {
        const persisted = readTopMeanActiveRun();
        if (!persisted?.runId) return;

        const dom = this.getDom();
        const runId = persisted.runId;
        this.activeTopMeanRunId = runId;
        this.topMeanDiagnosticRunId = runId;
        this.topMeanReattachInFlight = true;
        this.recordTopMeanDiagnostic("reattach.start", { runId });
        setVisible(dom.batchBacktestSp500TopMeanRunBtn, false);
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
        // closed below by sharing the consecutive-failure backoff state machine
        // (2s -> 5s -> 10s -> 15s, then a 60s low-cadence retry) with
        // the Batch reattach loop via ReattachBackoffController.
        const healthyDelay = (): Promise<void> => new Promise<void>((resolve) => {
            this.topMeanReattachTimerResolve = resolve;
            this.topMeanReattachTimer = setTimeout(resolve, 2_000);
        });
        this.topMeanReattachBackoff.reset();
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
                    if (res.status === 404) {
                        this.clearTopMeanRunAfterServerLoss(
                            dom,
                            "TOP_MEAN run was lost when the server restarted; local run state cleared.",
                        );
                        return;
                    }
                    // Audit: a non-2xx status is a transient failure, not a
                    // reason to abandon the reattach. Treat it like a thrown
                    // fetch so the backoff path engages; the prior behavior
                    // cleared the persisted run marker and tore down the
                    // reattach on a single hiccup.
                    if (!res.ok) {
                        throw new Error(`status ${res.status}`);
                    }
                    const status = await res.json() as TopMeanStatusResponse;
                    if (this.activeTopMeanRunId !== runId) return;
                    this.recordTopMeanDiagnostic("reattach.status", status);
                    dom.batchBacktestSp500TopMeanProgressText.textContent =
                        `[${status.phase}] ${status.progressText}`;

                    const terminal = status.status === "completed"
                        || status.status === "failed"
                        || status.status === "interrupted";
                    if (terminal) {
                        setVisible(dom.batchBacktestSp500TopMeanRunBtn, true);
                        setVisible(dom.batchBacktestSp500TopMeanStopBtn, false);
                        if (status.result) {
                            const result = mergeTopMeanArchiveStatus(status.result, status);
                            this.latestTopMeanResult = result;
                            this.persistLatestTopMeanResult(result);
                            this.renderTopMeanResults(dom, result);
                            dom.batchBacktestSp500TopMeanCopyBtn.disabled = false;
                            dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.disabled =
                                !Array.isArray(result.reportLines) || result.reportLines.length === 0;
                            dom.batchBacktestSp500TopMeanDownloadBtn.disabled = false;
                        }
                        if (status.status === "completed") {
                            dom.batchBacktestSp500TopMeanProgressText.textContent =
                                formatTopMeanCompletionMessage(status.result
                                    ? mergeTopMeanArchiveStatus(status.result, status)
                                    : status);
                        }
                        clearTopMeanActiveRun();
                        this.activeTopMeanRunId = null;
                        return;
                    }
                    // Successful poll resets the transient-failure counter.
                    this.topMeanReattachBackoff.recordSuccess();
                } catch (err) {
                    if (this.activeTopMeanRunId !== runId) return;
                    const outcome = this.topMeanReattachBackoff.recordFailure();
                    this.recordTopMeanDiagnostic("reattach.error", {
                        runId,
                        consecutive: outcome.consecutive,
                        name: err instanceof Error ? err.name : typeof err,
                        message: err instanceof Error ? err.message : String(err),
                    });
                    if (outcome.gaveUp) {
                        // Preserve ownership across a prolonged transient
                        // outage. The server may still be running; only a
                        // terminal response or HTTP 404 clears this marker.
                        this.topMeanReattachBackoff.reset();
                        dom.batchBacktestSp500TopMeanProgressText.textContent =
                            `Server connection lost — retrying status in 60s. Stop remains available.`;
                        await new Promise<void>((resolve) => {
                            this.topMeanReattachTimerResolve = resolve;
                            this.topMeanReattachTimer = setTimeout(resolve, 60_000);
                        });
                        this.topMeanReattachTimer = null;
                        this.topMeanReattachTimerResolve = null;
                        continue;
                    }
                    dom.batchBacktestSp500TopMeanProgressText.textContent =
                        `Server connection interrupted — retrying (${outcome.consecutive}/${outcome.max})`;
                    await new Promise<void>((resolve) => {
                        this.topMeanReattachTimerResolve = resolve;
                        this.topMeanReattachTimer = setTimeout(resolve, outcome.backoffDelayMs);
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
     * Cancel any in-flight TOP_MEAN reattach delay. Mirrors the Batch loop's
     * stop: clears the timer + resolves the pending delay promise so the loop
     * wakes immediately, checks `activeTopMeanRunId`, and exits when Stop has
     * cleared the id.
     */
    public stopTopMeanReattachPoll(): void {
        if (this.topMeanReattachTimer) {
            clearTimeout(this.topMeanReattachTimer);
            this.topMeanReattachTimer = null;
        }
        if (this.topMeanReattachTimerResolve) {
            this.topMeanReattachTimerResolve();
            this.topMeanReattachTimerResolve = null;
        }
    }

    /**
     * Detach from server-owned work BEFORE resolving polling delays, so the
     * loop wakes, sees the cleared run id, and does not schedule another timer.
     */
    public dispose(): void {
        this.activeTopMeanRunId = null;
        this.stopTopMeanReattachPoll();
        this.renderTopMeanDiagnosticDebounced.cancel();
        this.persistTopMeanDiagnosticDebounced.cancel();
    }
}

function formatSignedPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}
