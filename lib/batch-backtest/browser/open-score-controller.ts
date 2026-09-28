/**
 * Standalone OPEN_SCORE USD replay workflow owner: the server analysis
 * request/stream consumption, its single-flight lock, the stale-cancel flag,
 * and the retained result + copy action.
 *
 * Cross-workflow sequencing stays with the facade: the busy-button transitions
 * (begin/finishAnalysisBusy) and the pending-Stop handling live there and are
 * injected as narrow callbacks.
 */
import { debugLogger } from "../../debug-logger";
import { uiManager } from "../../ui-manager";
import { copyToClipboard } from "../../browser-transfer";
import { postBatchNdjson } from "../batch-ndjson-post";
import { isActiveCapTiltWeight } from "../cap-tilt-contract";
import type { OpenScoreUsdReplayResult } from "../open-score-replay/types";
import type { OpenScoreUsdReplayStreamEvent } from "../batch-open-score-usd-replay-stream-types";
import type { BatchBacktestDom } from "../batch-backtest-dom";

export class OpenScoreController {
    private readonly deps: {
        getDom: () => BatchBacktestDom;
        /** Facade shared pending-Stop sequencing (never coalesced there). */
        requestServerStop: () => Promise<void>;
        /** Facade busy-button transitions around the analysis. */
        beginAnalysisBusy: (dom: BatchBacktestDom) => void;
        finishAnalysisBusy: (dom: BatchBacktestDom) => Promise<void>;
        /** Run-owner artifact button refresh after the result lands. */
        updateArtifactActionButtons: (dom: BatchBacktestDom) => void;
        /** Run-owner fingerprint/artifact/interval inputs for the request. */
        serverHasArtifacts: () => boolean;
        lastRunFingerprint: () => string | null;
        lastRunInterval: () => string | null;
        /** Facade second-Stop sequencing after the route owns the lock. */
        reissueStopIfNeeded: () => Promise<void>;
    };

    // Serializes OPEN_SCORE USD Replay (and any future server-side analysis).
    private analysisInFlight = false;
    // Set when Stop races analysis preflight or POST establishment.
    private analysisCancelRequested = false;
    private lastResult: OpenScoreUsdReplayResult | null = null;

    constructor(deps: {
        getDom: () => BatchBacktestDom;
        requestServerStop: () => Promise<void>;
        beginAnalysisBusy: (dom: BatchBacktestDom) => void;
        finishAnalysisBusy: (dom: BatchBacktestDom) => Promise<void>;
        updateArtifactActionButtons: (dom: BatchBacktestDom) => void;
        serverHasArtifacts: () => boolean;
        lastRunFingerprint: () => string | null;
        lastRunInterval: () => string | null;
        reissueStopIfNeeded: () => Promise<void>;
    }) {
        this.deps = deps;
    }

    isBusy(): boolean {
        return this.analysisInFlight;
    }

    /** Facade-visible state seeding (regression suite preflight stubs). */
    setBusyForTests(value: boolean): void {
        this.analysisInFlight = value;
    }

    isCancelRequested(): boolean {
        return this.analysisCancelRequested;
    }

    setCancelRequested(value: boolean): void {
        this.analysisCancelRequested = value;
    }

    /** Facade-visible read for Copy Results inclusion and stale-result clearing. */
    getResult(): OpenScoreUsdReplayResult | null {
        return this.lastResult;
    }

    setResult(result: OpenScoreUsdReplayResult | null): void {
        this.lastResult = result;
    }

    /** Stop handler: flag cancellation; the POST response re-issues the Stop. */
    requestCancel(): void {
        this.analysisCancelRequested = true;
    }

    /** Drop the retained result and disable its copy button (stale results). */
    clearResult(dom: BatchBacktestDom): void {
        this.lastResult = null;
        dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdSummary.textContent = "";
    }

    public async run(): Promise<void> {
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.deps.getDom();
        try {
            if (!this.deps.serverHasArtifacts()) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Run Batch first.";
                return;
            }
            if (!this.deps.lastRunFingerprint()) {
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
            // Cap-tilt weighting (docs/open-score-cap-tilt.md). "off" is
            // omitted from the body so baseline requests stay byte-identical
            // to the pre-cap-tilt shape.
            const capTiltWeight = dom.batchBacktestOpenScoreUsdCapTilt.value;
            // Slippage/commission are NOT request fields: the server derives
            // them from the retained Batch run's slippageBps / commission so
            // the OPEN_SCORE USD replay uses the same execution-cost
            // assumptions as the artifacts it reads.

            this.deps.beginAnalysisBusy(dom);
            dom.batchBacktestOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestOpenScoreUsdSummary.textContent = "Replaying OPEN_SCORE events on server...";
            await postBatchNdjson<OpenScoreUsdReplayStreamEvent>({
                endpoint: "/api/batch-backtest/open-score-usd",
                body: {
                    fingerprint: this.deps.lastRunFingerprint()!,
                    interval: this.deps.lastRunInterval(),
                    horizons,
                    ...(sampleFrom ? { sampleFrom } : {}),
                    ...(sampleTo ? { sampleTo } : {}),
                    ...(isActiveCapTiltWeight(capTiltWeight) ? { capTiltWeight } : {}),
                },
                onResponse: () => this.deps.reissueStopIfNeeded(),
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
                            this.lastResult = event.result;
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
            this.lastResult = null;
            dom.batchBacktestOpenScoreUsdSummary.textContent = `OPEN_SCORE USD error: ${message}`;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            debugLogger.error("batch_open_score_usd.server_failed", { error: message });
        } finally {
            await this.deps.finishAnalysisBusy(dom);
        }
    }

    public async copyResults(): Promise<void> {
        if (!this.lastResult) {
            uiManager.showToast("No OPEN_SCORE USD report to copy", "info");
            return;
        }
        const text = this.lastResult.reportLines.join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast("OPEN_SCORE USD report copied", "success");
        } else {
            this.deps.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }
}
