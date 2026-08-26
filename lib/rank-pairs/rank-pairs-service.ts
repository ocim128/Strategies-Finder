/**
 * Rank Pairs browser control + rendering service.
 *
 * The Vite server owns loading, classification, cancellation, sorting, and
 * full Copy Results retention. The browser sends one run request, consumes
 * bounded progress events, renders at most 2,000 terminal preview rows, and
 * reattaches through /status after a page reload.
 */

import { parseBatchSymbols } from "../batch-backtest/batch-backtest-runner";
import { debugLogger } from "../debug-logger";
import { setVisible } from "../dom-utils";
import { debounce } from "../debounce";
import { consumeNdjsonStream } from "../ndjson-stream";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { state } from "../state";
import {
    formatAsOf,
    formatFixed,
    formatPercent,
    type PairDirection,
    type PairRegimeResult,
} from "./pair-regime-classifier";
import { createRankPairsDom, type RankPairsDom } from "./rank-pairs-dom";
import { prepareRankPairRelationships } from "./rank-pairs-input";
import {
    formatRankPairsPerformanceDiagnostics,
    type RankPairsPerformanceDiagnostics,
} from "./rank-pairs-performance";
import {
    formatCopyText,
    formatRecentCopyText,
    isRecentRankResult,
} from "./rank-pairs-result-format";
import {
    loadLatestRankPairsResultSnapshot,
    loadRankPairsSnapshotCopyText,
    type RankPairsResultSnapshot,
} from "./rank-pairs-result-store";
import {
    formatRecentPairMetrics,
    normalizeRecentPairEvalLastBars,
    normalizeRecentPairOosIgnoreLastBars,
    type RecentPairResult,
} from "./recent-pair-classifier";
import type {
    RankPairsRunStatusSnapshot,
    RankPairsStreamEvent,
} from "./server/rank-pairs-server-types";

export {
    COPY_COLUMNS,
    COPY_HEADER,
    formatCopyText,
    formatOverallSummary,
    formatRecentCopyText,
    formatRecentOverallSummary,
    RECENT_COPY_COLUMNS,
    RECENT_COPY_HEADER,
} from "./rank-pairs-result-format";
export {
    prepareRankPairRelationships,
    type PreparedRankPairRelationships,
} from "./rank-pairs-input";

export type RankPairsMode = "history" | "recent200";
export const RANK_PAIRS_RENDER_LIMIT = 2_000;

const ACTIVE_RUN_STORAGE = {
    key: "playground_rank_pairs_active_server_run",
    schema: "rank_pairs.active_server_run",
    version: 1,
} as const;

export interface RankResult {
    kind: "history";
    symbol: string;
    regime: PairRegimeResult;
    status: "ok" | "no_data" | "failed";
    error?: string;
}

export interface RecentRankResult {
    kind: "recent";
    symbol: string;
    recent: RecentPairResult;
    status: "ok" | "no_data" | "failed";
    error?: string;
}

type AnyRankResult = RankResult | RecentRankResult;

export function limitRankPairResultsForDisplay<T>(results: readonly T[]): readonly T[] {
    return results.length > RANK_PAIRS_RENDER_LIMIT
        ? results.slice(0, RANK_PAIRS_RENDER_LIMIT)
        : results;
}

const DIRECTION_CSS: Record<PairDirection, string> = {
    BASE: "finder-verdict-strong",
    NEUTRAL: "finder-verdict-marginal",
    QUOTE: "finder-verdict-losing",
    THIN: "finder-verdict-thin",
};
const FAILED_CSS = "finder-verdict-losing";

function badgeCssFor(result: RankResult): string {
    if (result.status === "ok") return DIRECTION_CSS[result.regime.direction];
    if (result.status === "no_data") return DIRECTION_CSS.THIN;
    return FAILED_CSS;
}

export function badgeLabelFor(result: RankResult): string {
    if (result.status === "ok") return result.regime.label;
    if (result.status === "no_data") return `THIN (${result.regime.reason})`;
    return "FAIL";
}

function formatResultRowPipe(result: RankResult): string {
    if (result.status !== "ok") {
        return result.status === "failed"
            ? `failed: ${result.error ?? "unknown"}`
            : `no data: ${result.regime.reason}`;
    }
    const metrics = result.regime.metrics;
    return [
        `Slope ${formatPercent(metrics.annualizedSlope)}`,
        `Vol ${formatPercent(metrics.annualizedVolatility)}`,
        `Eff ${formatFixed(metrics.pathEfficiency, 2)}`,
        `Rev ${formatFixed(metrics.reversalRate, 2)}`,
        `Recent ${metrics.hasRecentWindow ? formatFixed(metrics.recentNormalizedDrift, 2) : "n/a"}`,
        `Anchors ${metrics.anchorCount}`,
        `asOf ${formatAsOf(metrics.asOf)}`,
    ].join(" | ");
}

function recentBadgeCssFor(result: RecentRankResult): string {
    if (result.status === "failed") return FAILED_CSS;
    if (result.status === "no_data") return DIRECTION_CSS.THIN;
    return DIRECTION_CSS[result.recent.direction];
}

export function recentBadgeLabelFor(result: RecentRankResult): string {
    if (result.status === "ok") return result.recent.label;
    if (result.status === "no_data") return `TYPE J — THIN (${result.recent.reason})`;
    return "FAIL";
}

class RankPairsService {
    private dom: RankPairsDom | null = null;
    private initialized = false;
    private lastResults: AnyRankResult[] = [];
    private lastResultCount = 0;
    private lastSummaryText = "";
    private lastMode: RankPairsMode = "history";
    private lastSnapshot: RankPairsResultSnapshot<AnyRankResult> | null = null;
    private serverResultRunId: string | null = null;
    private activeServerRunId: string | null = null;
    private serverRunActive = false;
    private serverCopyAvailable = false;
    private runInFlight = false;
    private runToken = 0;
    private resultViewVersion = 0;
    private reattachGeneration = 0;
    private readonly updateSummaryDebounced = debounce(() => this.updateSummary(this.getDom()), 120);

    private getDom(): RankPairsDom {
        return this.dom ??= createRankPairsDom();
    }

    public init(): void {
        if (this.initialized) return;
        const dom = this.getDom();
        this.bindEvents(dom);
        this.syncRecentWindowControls(dom);
        this.updateSummary(dom);
        this.resetProgress(dom);
        this.initialized = true;
        this.activeServerRunId = this.loadPersistedActiveServerRun();
        this.serverRunActive = this.activeServerRunId !== null;
        const viewVersion = this.resultViewVersion;
        void this.restoreInitialResult(dom, viewVersion);
    }

    private bindEvents(dom: RankPairsDom): void {
        dom.rankPairsRunBtn.addEventListener("click", () => void this.runRank());
        dom.rankPairsStopBtn.addEventListener("click", () => void this.requestServerStop());
        dom.rankPairsCopyBtn.addEventListener("click", () => void this.copyResults());
        dom.rankPairsUseCurrent.addEventListener("click", () => {
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                const existing = dom.rankPairsSymbols.value.trim();
                dom.rankPairsSymbols.value = existing ? `${existing}\n${current}` : current;
            }
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.rankPairsClear.addEventListener("click", () => {
            dom.rankPairsSymbols.value = "";
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.rankPairsSymbols.addEventListener("input", () => {
            this.clearStaleResults(dom);
            this.updateSummaryDebounced();
        });
        dom.rankPairsMode.addEventListener("change", () => {
            this.clearStaleResults(dom);
            this.syncRecentWindowControls(dom);
            dom.rankPairsResults.replaceChildren();
            setVisible(dom.rankPairsEmpty, true);
            this.updateSummary(dom);
        });
    }

    private async runRank(): Promise<void> {
        if (this.runInFlight || this.serverRunActive) {
            this.getDom().rankPairsStatus.textContent = "Rank Pairs is already running.";
            return;
        }
        const dom = this.getDom();
        const inputSymbols = parseBatchSymbols(dom.rankPairsSymbols.value);
        if (inputSymbols.length === 0) {
            dom.rankPairsStatus.textContent = "Add at least one pair.";
            return;
        }
        if (prepareRankPairRelationships(inputSymbols).symbols.length === 0) {
            dom.rankPairsStatus.textContent = "Add at least one pair between different assets.";
            return;
        }

        const interval = state.currentInterval;
        const mode: RankPairsMode =
            dom.rankPairsMode.value === "recent200" ? "recent200" : "history";
        const evalLastBars = normalizeRecentPairEvalLastBars(dom.rankPairsEvalWindowBars.value);
        const oosIgnoreLastBars = normalizeRecentPairOosIgnoreLastBars(dom.rankPairsOosHoldoutBars.value);
        const runId =
            `rank-pairs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        this.runInFlight = true;
        this.runToken += 1;
        const token = this.runToken;
        this.reattachGeneration += 1;
        this.resultViewVersion += 1;
        this.lastResults = [];
        this.lastResultCount = 0;
        this.lastSummaryText = "";
        this.lastMode = mode;
        this.lastSnapshot = null;
        this.serverResultRunId = runId;
        this.activeServerRunId = runId;
        this.serverRunActive = true;
        this.serverCopyAvailable = false;
        this.persistActiveServerRun(runId);
        this.setServerBusy(dom, true);
        dom.rankPairsResults.replaceChildren();
        setVisible(dom.rankPairsEmpty, false);
        dom.rankPairsStatus.textContent = mode === "recent200"
            ? `Starting server-owned Rank Pairs run (eval ${evalLastBars > 0 ? evalLastBars : "all"} bars, OOS ${oosIgnoreLastBars} bars)...`
            : "Starting server-owned Rank Pairs run...";
        dom.rankPairsDiagnostics.textContent =
            "Server performance diagnostics appear after completion.";

        try {
            const response = await fetch("/api/rank-pairs/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    runId,
                    symbols: inputSymbols,
                    interval,
                    mode,
                    evalLastBars,
                    oosIgnoreLastBars,
                }),
            });
            if (!response.ok || !response.body) {
                const payload = await response.json().catch(() => null) as { error?: string } | null;
                throw new Error(payload?.error ?? `Server run failed (${response.status}).`);
            }
            await consumeNdjsonStream<RankPairsStreamEvent>(
                response.body,
                {
                    onStart: (event: Extract<RankPairsStreamEvent, { type: "start" }>) => {
                        if (token !== this.runToken) return;
                        dom.rankPairsStatus.textContent =
                            `Server: 0/${event.total.toLocaleString("en-US")}`
                            + ` • ${event.total.toLocaleString("en-US")} remaining`
                            + ` • ${event.workerConcurrency} loaders`
                            + (event.mode === "recent200"
                                ? ` • eval ${event.evalLastBars > 0 ? event.evalLastBars : "all"}, OOS ${event.oosIgnoreLastBars}`
                                : "");
                    },
                    onProgress: (event: Extract<RankPairsStreamEvent, { type: "progress" }>) => {
                        if (token !== this.runToken) return;
                        dom.rankPairsStatus.textContent = event.status;
                        this.setProgress(dom, event.percent, `${event.completed}/${event.total}`);
                    },
                    onDone: (event: Extract<RankPairsStreamEvent, { type: "done" }>) => {
                        if (token !== this.runToken) return;
                        this.applyTerminalResult(dom, {
                            runId: event.runId,
                            mode: event.mode,
                            evalLastBars: event.evalLastBars,
                            oosIgnoreLastBars: event.oosIgnoreLastBars,
                            interval: event.interval,
                            total: event.total,
                            resultCount: event.resultCount,
                            preview: event.preview,
                            summary: event.summary,
                            diagnostics: event.diagnostics,
                            copyAvailable: event.copyAvailable,
                            cancelled: event.cancelled,
                            reciprocalDuplicates: event.reciprocalDuplicates,
                            selfPairs: event.selfPairs,
                            statusText: event.cancelled
                                ? `Stopped (${event.resultCount}/${event.total} pairs)`
                                : `Done (${event.resultCount} relationships)`,
                        });
                    },
                    onFatal: (event: Extract<RankPairsStreamEvent, { type: "fatal" }>) => {
                        if (token !== this.runToken) return;
                        this.serverRunActive = false;
                        this.serverCopyAvailable = false;
                        this.clearActiveServerRun(event.runId);
                        dom.rankPairsStatus.textContent = `Server Rank Pairs failed: ${event.error}`;
                    },
                },
                { requireTerminal: true, terminalTypes: ["done", "fatal"] },
            );
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.warn("rank_pairs.server.stream_interrupted", { runId, error: message });
            dom.rankPairsStatus.textContent = "Server connection interrupted; reattaching...";
            const recovered = await this.reattachServerRun(runId, this.resultViewVersion);
            if (!recovered && token === this.runToken) {
                this.serverRunActive = false;
                this.clearActiveServerRun(runId);
                dom.rankPairsStatus.textContent = `Server Rank Pairs failed: ${message}`;
            }
        } finally {
            if (token === this.runToken) {
                this.runInFlight = false;
                if (!this.serverRunActive) this.setServerBusy(dom, false);
            }
        }
    }

    private applyTerminalResult(
        dom: RankPairsDom,
        result: {
            runId: string;
            mode: RankPairsMode;
            evalLastBars: number;
            oosIgnoreLastBars: number;
            interval: string;
            total: number;
            resultCount: number;
            preview: AnyRankResult[];
            summary: string;
            diagnostics: RankPairsPerformanceDiagnostics | null;
            copyAvailable: boolean;
            cancelled: boolean;
            reciprocalDuplicates: number;
            selfPairs: number;
            statusText: string;
        },
    ): void {
        this.lastResults = result.preview;
        this.lastResultCount = result.resultCount;
        this.lastSummaryText = result.summary;
        this.lastMode = result.mode;
        this.lastSnapshot = null;
        this.serverResultRunId = result.runId;
        this.serverCopyAvailable = result.copyAvailable;
        this.serverRunActive = false;
        this.activeServerRunId = null;
        this.clearActiveServerRun(result.runId);
        dom.rankPairsMode.value = result.mode;
        dom.rankPairsEvalWindowBars.value = String(result.evalLastBars);
        dom.rankPairsOosHoldoutBars.value = String(result.oosIgnoreLastBars);
        this.syncRecentWindowControls(dom);
        this.renderPreview(dom, result.preview, result.resultCount);
        dom.rankPairsSummary.textContent = result.summary;
        dom.rankPairsDiagnostics.textContent = result.diagnostics
            ? formatRankPairsPerformanceDiagnostics(result.diagnostics)
            : "No performance diagnostics available.";
        dom.rankPairsStatus.textContent = result.mode === "recent200"
            ? `${result.statusText} (eval ${result.evalLastBars > 0 ? result.evalLastBars : "all"} bars, OOS ${result.oosIgnoreLastBars})`
            : result.statusText;
        if (result.reciprocalDuplicates > 0 || result.selfPairs > 0) {
            dom.rankPairsStatus.textContent +=
                `; ${result.reciprocalDuplicates} reciprocal duplicates skipped; ${result.selfPairs} self-pairs skipped`;
        }
        if (result.resultCount > result.preview.length) {
            dom.rankPairsStatus.textContent +=
                `; showing top ${result.preview.length.toLocaleString("en-US")} rows (Copy Results includes all)`;
        }
        this.setProgress(
            dom,
            result.cancelled && result.total > 0
                ? (result.resultCount / result.total) * 100
                : 100,
            result.cancelled ? "Stopped" : "Done",
        );
        this.setServerBusy(dom, false);
    }

    private async requestServerStop(): Promise<void> {
        const runId = this.activeServerRunId;
        if (!runId) return;
        const dom = this.getDom();
        dom.rankPairsStatus.textContent = "Stopping server run...";
        try {
            const response = await fetch("/api/rank-pairs/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId }),
            });
            const payload = await response.json().catch(() => null) as
                | { ok?: boolean; error?: string }
                | null;
            if (!response.ok || payload?.ok === false) {
                throw new Error(payload?.error ?? "The active server run belongs to another tab.");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dom.rankPairsStatus.textContent = `Stop request failed: ${message}`;
            debugLogger.warn("rank_pairs.server.stop_failed", { runId, error: message });
        }
    }

    private async restoreInitialResult(dom: RankPairsDom, viewVersion: number): Promise<void> {
        const restored = await this.reattachServerRun(this.activeServerRunId, viewVersion);
        if (!restored && viewVersion === this.resultViewVersion) {
            await this.restoreLocalResult(dom, viewVersion);
        }
    }

    private async reattachServerRun(
        requestedRunId: string | null,
        viewVersion: number,
    ): Promise<boolean> {
        const generation = ++this.reattachGeneration;
        const dom = this.getDom();
        let failures = 0;
        for (;;) {
            if (
                generation !== this.reattachGeneration
                || viewVersion !== this.resultViewVersion
            ) {
                return false;
            }
            try {
                const scope = requestedRunId
                    ? `?runId=${encodeURIComponent(requestedRunId)}`
                    : "";
                const response = await fetch(`/api/rank-pairs/status${scope}`, {
                    cache: "no-store",
                });
                if (response.status === 404) return false;
                if (!response.ok) throw new Error(`Status failed (${response.status}).`);
                const snapshot = await response.json() as RankPairsRunStatusSnapshot;
                failures = 0;
                if (
                    generation !== this.reattachGeneration
                    || viewVersion !== this.resultViewVersion
                ) {
                    return false;
                }
                requestedRunId = snapshot.runId;
                this.serverResultRunId = snapshot.runId;
                if (snapshot.terminal) {
                    if (snapshot.phase === "fatal") {
                        this.serverRunActive = false;
                        this.serverCopyAvailable = false;
                        this.clearActiveServerRun(snapshot.runId);
                        dom.rankPairsStatus.textContent =
                            `Server Rank Pairs failed: ${snapshot.error ?? snapshot.statusText}`;
                        this.setServerBusy(dom, false);
                        return true;
                    }
                    this.applyTerminalResult(dom, {
                        runId: snapshot.runId,
                        mode: snapshot.mode,
                        evalLastBars: snapshot.evalLastBars,
                        oosIgnoreLastBars: snapshot.oosIgnoreLastBars,
                        interval: snapshot.interval,
                        total: snapshot.total,
                        resultCount: snapshot.resultCount,
                        preview: snapshot.terminalPreview ?? [],
                        summary: snapshot.summary ?? `Pairs ${snapshot.resultCount}`,
                        diagnostics: snapshot.diagnostics,
                        copyAvailable: snapshot.copyAvailable,
                        cancelled: snapshot.cancelled,
                        reciprocalDuplicates: snapshot.reciprocalDuplicates,
                        selfPairs: snapshot.selfPairs,
                        statusText: snapshot.statusText,
                    });
                    return true;
                }

                this.activeServerRunId = snapshot.runId;
                this.serverRunActive = true;
                this.persistActiveServerRun(snapshot.runId);
                this.setServerBusy(dom, true);
                dom.rankPairsMode.value = snapshot.mode;
                dom.rankPairsEvalWindowBars.value = String(snapshot.evalLastBars);
                dom.rankPairsOosHoldoutBars.value = String(snapshot.oosIgnoreLastBars);
                this.syncRecentWindowControls(dom);
                dom.rankPairsStatus.textContent = snapshot.statusText;
                this.setProgress(
                    dom,
                    snapshot.progressPercent,
                    `${snapshot.completed}/${snapshot.total}`,
                );
                await new Promise<void>((resolve) => setTimeout(resolve, 500));
            } catch (error) {
                failures += 1;
                debugLogger.warn("rank_pairs.server.reattach_poll_failed", {
                    runId: requestedRunId,
                    failures,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (failures >= 5) return false;
                await new Promise<void>((resolve) => setTimeout(resolve, failures * 500));
            }
        }
    }

    private async copyResults(): Promise<void> {
        if (this.lastResultCount === 0) return;
        const dom = this.getDom();
        dom.rankPairsCopyBtn.disabled = true;
        dom.rankPairsStatus.textContent =
            `Preparing ${this.lastResultCount.toLocaleString("en-US")} saved rows for clipboard…`;
        try {
            let text: string;
            if (this.serverResultRunId && this.serverCopyAvailable) {
                const response = await fetch(
                    `/api/rank-pairs/copy?runId=${encodeURIComponent(this.serverResultRunId)}`,
                    { cache: "no-store" },
                );
                if (!response.ok) {
                    const payload = await response.json().catch(() => null) as { error?: string } | null;
                    throw new Error(payload?.error ?? `Copy download failed (${response.status}).`);
                }
                text = await response.text();
            } else if (this.lastSnapshot) {
                text = await loadRankPairsSnapshotCopyText(this.lastSnapshot);
            } else {
                text = this.lastMode === "recent200"
                    ? formatRecentCopyText(this.lastResults.filter(isRecentRankResult))
                    : formatCopyText(this.lastResults.filter(
                        (result): result is RankResult => !isRecentRankResult(result),
                    ));
            }
            await navigator.clipboard.writeText(text);
            dom.rankPairsStatus.textContent =
                `Copied ${this.lastResultCount.toLocaleString("en-US")} rows.`;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dom.rankPairsStatus.textContent = `Copy failed: ${message}`;
            debugLogger.warn("rank_pairs.copy_failed", { error: message });
        } finally {
            dom.rankPairsCopyBtn.disabled = this.lastResultCount === 0;
        }
    }

    private clearStaleResults(dom: RankPairsDom): void {
        if (this.serverRunActive) return;
        this.resultViewVersion += 1;
        this.reattachGeneration += 1;
        if (this.lastResultCount === 0) return;
        this.lastResults = [];
        this.lastResultCount = 0;
        this.lastSummaryText = "";
        this.lastSnapshot = null;
        this.serverResultRunId = null;
        this.serverCopyAvailable = false;
        dom.rankPairsCopyBtn.disabled = true;
        dom.rankPairsDiagnostics.textContent = "Performance diagnostics appear after a run.";
    }

    private async restoreLocalResult(dom: RankPairsDom, viewVersion: number): Promise<void> {
        try {
            const snapshot = await loadLatestRankPairsResultSnapshot<AnyRankResult>();
            if (
                !snapshot
                || viewVersion !== this.resultViewVersion
                || this.lastResultCount > 0
            ) {
                return;
            }
            this.lastSnapshot = snapshot;
            const restoredKind = snapshot.mode === "recent200" ? "recent" : "history";
            this.lastResults = snapshot.preview.map((result) => ({
                ...result,
                kind: restoredKind,
            })) as AnyRankResult[];
            this.lastResultCount = snapshot.resultCount;
            this.lastSummaryText = snapshot.summaryText;
            this.lastMode = snapshot.mode;
            this.serverResultRunId = null;
            this.serverCopyAvailable = false;
            dom.rankPairsMode.value = snapshot.mode;
            this.syncRecentWindowControls(dom);
            this.renderPreview(dom, this.lastResults, snapshot.resultCount);
            dom.rankPairsSummary.textContent = snapshot.summaryText;
            dom.rankPairsDiagnostics.textContent = snapshot.diagnosticsText;
            dom.rankPairsStatus.textContent =
                `Restored local result from ${new Date(snapshot.completedAt).toLocaleString()} (${snapshot.interval})`;
            this.setProgress(dom, 100, "Restored");
        } catch (error) {
            debugLogger.warn("rank_pairs.snapshot_restore_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private renderPreview(
        dom: RankPairsDom,
        preview: readonly AnyRankResult[],
        resultCount: number,
    ): void {
        const fragment = document.createDocumentFragment();
        for (const result of preview) fragment.appendChild(this.createResultRow(result));
        dom.rankPairsResults.replaceChildren(fragment);
        setVisible(dom.rankPairsEmpty, resultCount === 0);
        dom.rankPairsCopyBtn.disabled =
            resultCount === 0 || (!this.serverCopyAvailable && !this.lastSnapshot);
    }

    private createResultRow(result: AnyRankResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${
            isRecentRankResult(result) ? recentBadgeCssFor(result) : badgeCssFor(result)
        }`;
        badge.textContent = isRecentRankResult(result)
            ? recentBadgeLabelFor(result)
            : badgeLabelFor(result);
        line.appendChild(badge);
        const evidence = isRecentRankResult(result)
            ? result.status === "ok"
                ? formatRecentPairMetrics(result.recent)
                : result.status === "failed"
                    ? `failed: ${result.error ?? "unknown"}`
                    : `no data: ${result.recent.reason}`
            : formatResultRowPipe(result);
        line.appendChild(document.createTextNode(` ${result.symbol} | ${evidence}`));
        return line;
    }

    private setServerBusy(dom: RankPairsDom, busy: boolean): void {
        dom.rankPairsRunBtn.disabled = busy;
        dom.rankPairsMode.disabled = busy;
        dom.rankPairsEvalWindowBars.disabled = busy;
        dom.rankPairsOosHoldoutBars.disabled = busy;
        setVisible(dom.rankPairsStopBtn, busy);
        dom.rankPairsCopyBtn.disabled =
            busy || this.lastResultCount === 0 || (!this.serverCopyAvailable && !this.lastSnapshot);
    }

    private setProgress(dom: RankPairsDom, percent: number, text: string): void {
        dom.rankPairsProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.rankPairsProgressText.textContent = text;
    }

    private resetProgress(dom: RankPairsDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.rankPairsStatus.textContent = "Idle";
    }

    private syncRecentWindowControls(dom: RankPairsDom): void {
        setVisible(dom.rankPairsRecentWindowSettings, dom.rankPairsMode.value === "recent200");
    }

    private updateSummary(dom: RankPairsDom): void {
        if (this.lastResultCount > 0) {
            dom.rankPairsSummary.textContent = this.lastSummaryText;
            return;
        }
        const count = parseBatchSymbols(dom.rankPairsSymbols.value).length;
        dom.rankPairsSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
    }

    private persistActiveServerRun(runId: string): void {
        writePersistedJson({
            ...ACTIVE_RUN_STORAGE,
            data: { runId, startedAt: Date.now() },
            onError: (error) => debugLogger.warn("rank_pairs.active_run_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }

    private loadPersistedActiveServerRun(): string | null {
        return readPersistedJson<string | null>({
            ...ACTIVE_RUN_STORAGE,
            fallback: null,
            migrate: ({ data }) => {
                if (!data || typeof data !== "object" || Array.isArray(data)) return null;
                const runId = (data as { runId?: unknown }).runId;
                return typeof runId === "string" && runId.trim() ? runId.trim() : null;
            },
        });
    }

    private clearActiveServerRun(expectedRunId: string): void {
        if (this.activeServerRunId && this.activeServerRunId !== expectedRunId) return;
        this.activeServerRunId = null;
        writePersistedJson({
            ...ACTIVE_RUN_STORAGE,
            data: null,
            onError: (error) => debugLogger.warn("rank_pairs.active_run_clear_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }
}

export const rankPairsService = new RankPairsService();
