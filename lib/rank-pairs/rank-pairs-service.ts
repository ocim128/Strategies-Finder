/**
 * Rank Pairs UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/batch-backtest/batch-backtest-service.ts`). Binds the tab's buttons,
 * reads the CURRENT chart interval once per run, fetches each pair's OHLCV via
 * the shared batch loader (so shared synthetic legs are deduped), and
 * classifies each pair with either the full-history regime classifier or the
 * latest-200 chart-shape classifier selected in the tab.
 *
 * Output rows mirror Batch Backtest's `finder-symbol-row` shape with a regime
 * badge + pipe-formatted evidence, so a Rank run reads the same as a Batch run.
 *
 * ⚠ Research only: the regime label spans a multiyear historical window and has
 * lookahead bias. Surfaced in the tab's hint banner.
 */

import { state } from "../state";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { createTaskYielder } from "../task-yield";
import { parseBatchSymbols } from "../batch-backtest/batch-backtest-runner";
import {
    getBatchDatasetCacheStats,
    loadBatchDataset,
} from "../batch-backtest/batch-backtest-loader";
import { createRankPairsDom, type RankPairsDom } from "./rank-pairs-dom";
import {
    buildRankPairsCacheDelta,
    createRankPairsPerformanceTimings,
    formatRankPairsPerformanceDiagnostics,
    nowRankPairsMs,
    type RankPairsPerformanceDiagnostics,
} from "./rank-pairs-performance";
import {
    getRankPairsRecentLoaderStats,
    loadRecentRankPairDataset,
} from "./rank-pairs-recent-loader";
import {
    loadLatestRankPairsResultSnapshot,
    loadRankPairsSnapshotCopyText,
    saveLatestRankPairsResultSnapshot,
    type RankPairsResultSnapshot,
} from "./rank-pairs-result-store";
import type { OHLCVData } from "../types/strategies";
import {
    classifyPairRegime,
    comparePairRegimeResults,
    formatAsOf,
    formatFixed,
    formatPercent,
    type PairDirection,
    type PairRegimeResult,
    type PairStructure,
} from "./pair-regime-classifier";
import {
    classifyRecentPair,
    compareRecentPairResults,
    formatRecentPairMetrics,
    type RecentPairResult,
    type RecentPairType,
} from "./recent-pair-classifier";

export type RankPairsMode = "history" | "recent200";
export const RANK_PAIRS_RENDER_LIMIT = 2_000;

/** A ranked pair row. Exported for service-level copy/summary tests. */
export interface RankResult {
    symbol: string;
    regime: PairRegimeResult;
    status: "ok" | "no_data" | "failed";
    error?: string;
}

/** A latest-200 chart-shape row. */
export interface RecentRankResult {
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

export interface PreparedRankPairRelationships {
    symbols: string[];
    reciprocalDuplicates: number;
    selfPairs: number;
}

/** Keep one orientation per relationship and discard meaningless A+A pairs. */
export function prepareRankPairRelationships(
    symbols: string[],
): PreparedRankPairRelationships {
    const seen = new Set<string>();
    const unique: string[] = [];
    let reciprocalDuplicates = 0;
    let selfPairs = 0;
    for (const symbol of symbols) {
        const plus = symbol.indexOf("+");
        const base = plus > 0 ? symbol.slice(0, plus).trim() : "";
        const quote = plus > 0 ? symbol.slice(plus + 1).trim() : "";
        if (base && quote && base.toUpperCase() === quote.toUpperCase()) {
            selfPairs += 1;
            continue;
        }
        const key = base && quote
            ? [base.toUpperCase(), quote.toUpperCase()].sort().join("+")
            : symbol.toUpperCase();
        if (seen.has(key)) {
            reciprocalDuplicates += 1;
            continue;
        }
        seen.add(key);
        unique.push(symbol);
    }
    return { symbols: unique, reciprocalDuplicates, selfPairs };
}

const DIRECTION_ORDER: PairDirection[] = ["BASE", "NEUTRAL", "QUOTE", "THIN"];

// Reuse Batch Backtest / Finder verdict CSS classes (single hyphen) so the
// badges pick up the existing palette without new styles.
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

/** Badge label. Exported for service tests. */
export function badgeLabelFor(result: RankResult): string {
    if (result.status === "ok") return result.regime.label;
    if (result.status === "no_data") {
        // Surface the actual reason (INSUFFICIENT_ANCHORS, ZERO_VARIANCE, …)
        // rather than masking every no-data row as an identical THIN / THIN.
        return `THIN (${result.regime.reason})`;
    }
    return "FAIL";
}

function formatResultRowPipe(result: RankResult): string {
    if (result.status !== "ok") {
        // Distinguish a load failure from an insufficient-coverage no-data row.
        return result.status === "failed"
            ? `failed: ${result.error ?? "unknown"}`
            : `no data: ${result.regime.reason}`;
    }
    const m = result.regime.metrics;
    const recentDir = m.hasRecentWindow
        ? formatFixed(m.recentNormalizedDrift, 2)
        : "n/a";
    const parts = [
        `Slope ${formatPercent(m.annualizedSlope)}`,
        `Vol ${formatPercent(m.annualizedVolatility)}`,
        `Eff ${formatFixed(m.pathEfficiency, 2)}`,
        `Rev ${formatFixed(m.reversalRate, 2)}`,
        `Recent ${recentDir}`,
        `Anchors ${m.anchorCount}`,
        `asOf ${formatAsOf(m.asOf)}`,
    ];
    return parts.join(" | ");
}

/** Summary line. Exported for service tests. */
export function formatOverallSummary(results: RankResult[]): string {
    // Only genuinely-classified (status "ok") pairs contribute to direction and
    // structure counts. no_data and failed rows are tracked separately so they
    // are never double-counted as THIN.
    const ok = results.filter((r) => r.status === "ok");
    const dirCounts: Record<PairDirection, number> = { BASE: 0, NEUTRAL: 0, QUOTE: 0, THIN: 0 };
    const structCounts: Record<PairStructure, number> = {
        TREND: 0, OSCILLATING: 0, TRANSITION: 0, REVERSAL: 0, MIXED: 0, THIN: 0,
    };
    for (const r of ok) {
        dirCounts[r.regime.direction] += 1;
        structCounts[r.regime.structure] += 1;
    }
    const noData = results.filter((r) => r.status === "no_data").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const parts = [`Pairs ${results.length}`];
    for (const d of DIRECTION_ORDER) {
        parts.push(`${d} ${dirCounts[d]}`);
    }
    // Structure counts (display order mirrors the sort group order).
    parts.push(
        `TREND ${structCounts.TREND}`,
        `OSC ${structCounts.OSCILLATING}`,
        `TRANS ${structCounts.TRANSITION}`,
        `REV ${structCounts.REVERSAL}`,
        `MIXED ${structCounts.MIXED}`,
    );
    parts.push(`NODATA ${noData}`, `FAILED ${failed}`);
    return parts.join(" | ");
}

export const COPY_HEADER = "RANK_PAIRS_V2";
export const COPY_COLUMNS = [
    "PAIR",
    "STATUS",
    "DIRECTION",
    "STRUCTURE",
    "LABEL",
    "REASON",
    "ERROR",
    "RATIO_RET",
    "LOG_RET",
    "ANN_SLOPE",
    "ANN_VOL",
    "NORM_DRIFT",
    "PATH_EFF",
    "REVERSAL_RATE",
    "HAS_RECENT",
    "RECENT_DRIFT",
    "RECENT_EFF",
    "ENDPOINT_RATIO",
    "IN_BAND",
    "ANCHORS",
    "BARS",
    "ELAPSED_DAYS",
    "AS_OF",
];

function scalarRow(result: RankResult): string {
    const m = result.regime.metrics;
    const fields = [
        result.symbol,
        result.status,
        result.regime.direction,
        result.regime.structure,
        result.regime.label,
        result.regime.reason,
        result.error ?? "",
        formatPercent(m.ratioReturn),
        formatFixed(m.logReturn, 4),
        formatPercent(m.annualizedSlope),
        formatPercent(m.annualizedVolatility),
        formatFixed(m.normalizedDrift, 3),
        formatFixed(m.pathEfficiency, 3),
        formatFixed(m.reversalRate, 3),
        m.hasRecentWindow ? "yes" : "no",
        formatFixed(m.recentNormalizedDrift, 3),
        formatFixed(m.recentPathEfficiency, 3),
        formatFixed(m.endpointRatio, 4),
        m.endpointInsideBand === null ? "n/a" : m.endpointInsideBand ? "yes" : "no",
        String(m.anchorCount),
        String(m.barCount),
        formatFixed(m.elapsedDays, 0),
        formatAsOf(m.asOf),
    ];
    return fields.join(" | ");
}

/** Copy-Results text. Exported for service tests. */
export function formatCopyText(results: RankResult[]): string {
    // Deterministic copy ordering mirrors the rendered list: regime group order
    // with within-group tie-breaks, failed/no-data rows last by symbol.
    const ranked = results
        .map((r, idx) => ({ r, idx }))
        .sort((a, b) => compareRankResultsForDisplay(a.r, b.r, a.idx, b.idx));
    const lines = [COPY_HEADER, COPY_COLUMNS.join(" | ")];
    for (const { r } of ranked) lines.push(scalarRow(r));
    return lines.join("\n");
}

export const RECENT_COPY_HEADER = "RANK_PAIRS_RECENT_200_V1";
export const RECENT_COPY_COLUMNS = [
    "PAIR",
    "STATUS",
    "TYPE",
    "DIRECTION",
    "LABEL",
    "REASON",
    "ERROR",
    "RATIO_RET",
    "LOG_RET",
    "PATH_EFF",
    "REVERSAL_RATE",
    "VOL_RATIO",
    "BASELINE_TREND",
    "RECENT_TREND",
    "LEVEL_SHIFT_SIGMA",
    "BARS",
    "AS_OF",
];

const RECENT_TYPE_ORDER: RecentPairType[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

/** Latest-200 summary line. */
export function formatRecentOverallSummary(results: RecentRankResult[]): string {
    const counts = Object.fromEntries(
        RECENT_TYPE_ORDER.map((type) => [type, 0]),
    ) as Record<RecentPairType, number>;
    let failed = 0;
    for (const result of results) {
        if (result.status === "failed") failed += 1;
        else counts[result.recent.type] += 1;
    }
    const parts = [`Pairs ${results.length}`];
    for (const type of RECENT_TYPE_ORDER) parts.push(`TYPE ${type} ${counts[type]}`);
    parts.push(`FAILED ${failed}`);
    return parts.join(" | ");
}

function recentScalarRow(result: RecentRankResult): string {
    const m = result.recent.metrics;
    return [
        result.symbol,
        result.status,
        result.recent.type,
        result.recent.direction,
        result.recent.label,
        result.recent.reason,
        result.error ?? "",
        formatPercent(m.ratioReturn),
        formatFixed(m.logReturn, 4),
        formatFixed(m.pathEfficiency, 3),
        formatFixed(m.reversalRate, 3),
        formatFixed(m.volatilityRatio, 3),
        formatFixed(m.baselineTrendStrength, 3),
        formatFixed(m.recentTrendStrength, 3),
        formatFixed(m.levelShiftSigma, 3),
        String(m.barCount),
        formatAsOf(m.asOf),
    ].join(" | ");
}

/** Latest-200 Copy Results contract. */
export function formatRecentCopyText(results: RecentRankResult[]): string {
    const ranked = results
        .map((result, index) => ({ result, index }))
        .sort((a, b) => {
            const cmp = compareRecentPairResults(a.result.recent, b.result.recent);
            return cmp !== 0 ? cmp : a.index - b.index;
        });
    return [
        RECENT_COPY_HEADER,
        RECENT_COPY_COLUMNS.join(" | "),
        ...ranked.map(({ result }) => recentScalarRow(result)),
    ].join("\n");
}

function isRecentRankResult(result: AnyRankResult): result is RecentRankResult {
    return "recent" in result;
}

function recentBadgeCssFor(result: RecentRankResult): string {
    if (result.status === "failed") return FAILED_CSS;
    if (result.status === "no_data") return DIRECTION_CSS.THIN;
    return DIRECTION_CSS[result.recent.direction];
}

/** Latest-200 badge label. */
export function recentBadgeLabelFor(result: RecentRankResult): string {
    if (result.status === "ok") return result.recent.label;
    if (result.status === "no_data") return `TYPE J — THIN (${result.recent.reason})`;
    return "FAIL";
}

/**
 * Display comparator wrapping the pure regime comparator. Failed/no-data rows
 * sort after every regime result (they fall into the THIN group), with stable
 * input order as the fallback so streaming order is preserved among ties.
 */
function compareRankResultsForDisplay(
    a: RankResult,
    b: RankResult,
    aIdx: number,
    bIdx: number,
): number {
    const cmp = comparePairRegimeResults(a.regime, b.regime);
    if (cmp !== 0) return cmp;
    return aIdx - bIdx;
}

function compareAnyResultsForDisplay(
    a: AnyRankResult,
    b: AnyRankResult,
    aIdx: number,
    bIdx: number,
    mode: RankPairsMode,
): number {
    if (mode === "recent200" && isRecentRankResult(a) && isRecentRankResult(b)) {
        const cmp = compareRecentPairResults(a.recent, b.recent);
        return cmp !== 0 ? cmp : aIdx - bIdx;
    }
    if (!isRecentRankResult(a) && !isRecentRankResult(b)) {
        return compareRankResultsForDisplay(a, b, aIdx, bIdx);
    }
    return aIdx - bIdx;
}

class RankPairsService {
    private dom: RankPairsDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: AnyRankResult[] = [];
    private lastResultCount = 0;
    private lastSummaryText = "";
    private lastMode: RankPairsMode = "history";
    private lastDiagnostics: RankPairsPerformanceDiagnostics | null = null;
    private lastSnapshot: RankPairsResultSnapshot<AnyRankResult> | null = null;
    private resultViewVersion = 0;
    // Monotonic run token — see BatchBacktestService for the rationale:
    // a stale run that resumes after a newer run started sees its token as
    // stale and stops writing DOM/state.
    private runToken = 0;
    private abortController: AbortController | null = null;

    private getDom(): RankPairsDom {
        return this.dom ??= createRankPairsDom();
    }

    public init(): void {
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.updateSummary(dom);
        this.resetProgress(dom);
        this.initialized = true;
        const resultViewVersion = this.resultViewVersion;
        void this.restoreLastResult(dom, resultViewVersion);
    }

    private bindEvents(dom: RankPairsDom): void {
        dom.rankPairsRunBtn.addEventListener("click", () => {
            void this.runRank();
        });
        dom.rankPairsStopBtn.addEventListener("click", () => {
            this.cancelled = true;
            this.abortController?.abort();
        });
        dom.rankPairsCopyBtn.addEventListener("click", () => {
            void this.copyResults();
        });
        dom.rankPairsUseCurrent.addEventListener("click", () => {
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                dom.rankPairsSymbols.value = dom.rankPairsSymbols.value.trim();
                dom.rankPairsSymbols.value = dom.rankPairsSymbols.value
                    ? `${dom.rankPairsSymbols.value}\n${current}`
                    : current;
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
            this.updateSummary(dom);
        });
        dom.rankPairsMode.addEventListener("change", () => {
            this.clearStaleResults(dom);
            dom.rankPairsResults.replaceChildren();
            setVisible(dom.rankPairsEmpty, true);
            this.updateSummary(dom);
        });
    }

    private async runRank(): Promise<void> {
        const runStartedAt = nowRankPairsMs();
        const timingsMs = createRankPairsPerformanceTimings();
        const dom = this.getDom();
        const parseStartedAt = nowRankPairsMs();
        const inputSymbols = parseBatchSymbols(dom.rankPairsSymbols.value);
        timingsMs.parseInput = nowRankPairsMs() - parseStartedAt;
        if (inputSymbols.length === 0) {
            dom.rankPairsStatus.textContent = "Add at least one pair.";
            return;
        }
        const prepareStartedAt = nowRankPairsMs();
        const prepared = prepareRankPairRelationships(inputSymbols);
        timingsMs.prepareRelationships = nowRankPairsMs() - prepareStartedAt;
        const symbols = prepared.symbols;
        if (symbols.length === 0) {
            dom.rankPairsStatus.textContent = "Add at least one pair between different assets.";
            return;
        }

        const interval = state.currentInterval;
        const mode: RankPairsMode = dom.rankPairsMode.value === "recent200"
            ? "recent200"
            : "history";
        const startedAt = Date.now();
        const cacheBefore = getBatchDatasetCacheStats();
        const recentCacheBefore = getRankPairsRecentLoaderStats();
        let totalBars = 0;

        this.runToken += 1;
        const token = this.runToken;
        this.resultViewVersion += 1;
        this.cancelled = false;
        this.lastResults = [];
        this.lastResultCount = 0;
        this.lastSummaryText = "";
        this.lastMode = mode;
        this.lastDiagnostics = null;
        this.lastSnapshot = null;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        const taskYielder = createTaskYielder();

        dom.rankPairsRunBtn.disabled = true;
        dom.rankPairsMode.disabled = true;
        setVisible(dom.rankPairsStopBtn, true);
        dom.rankPairsCopyBtn.disabled = true;
        setVisible(dom.rankPairsEmpty, false);
        dom.rankPairsResults.replaceChildren();
        dom.rankPairsDiagnostics.textContent =
            "Measuring load, classification, rendering, and yield time…";

        try {
            for (let i = 0; i < symbols.length; i += 1) {
                if (token !== this.runToken || this.cancelled) break;
                const symbol = symbols[i];

                let result: AnyRankResult;
                try {
                    let bars: OHLCVData[];
                    const loadStartedAt = nowRankPairsMs();
                    try {
                        const recentBars = mode === "recent200"
                            ? await loadRecentRankPairDataset(symbol, interval, signal)
                            : null;
                        bars = recentBars ?? await loadBatchDataset(symbol, interval, signal);
                    } finally {
                        timingsMs.load += nowRankPairsMs() - loadStartedAt;
                    }
                    if (token !== this.runToken) return;
                    totalBars += bars.length;
                    if (!signal.aborted && bars.length > 0) {
                        const classifyStartedAt = nowRankPairsMs();
                        if (mode === "recent200") {
                            const recent = classifyRecentPair(bars);
                            recent.symbol = symbol;
                            result = {
                                symbol,
                                recent,
                                status: recent.type === "J" ? "no_data" : "ok",
                            };
                        } else {
                            const regime = classifyPairRegime(bars);
                            regime.symbol = symbol;
                            // The classifier returns THIN with an INSUFFICIENT_*
                            // reason when coverage fails; surface those as no_data
                            // rows distinct from genuine classifications.
                            const isThin =
                                regime.direction === "THIN" && regime.reason !== "OK";
                            result = { symbol, regime, status: isThin ? "no_data" : "ok" };
                        }
                        timingsMs.classify += nowRankPairsMs() - classifyStartedAt;
                    } else {
                        result = mode === "recent200"
                            ? {
                                symbol,
                                recent: emptyThinRecent(symbol),
                                status: "no_data",
                            }
                            : {
                                symbol,
                                regime: emptyThinRegime(symbol),
                                status: "no_data",
                            };
                    }
                } catch (error) {
                    if (token !== this.runToken) return;
                    const message = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("rank_pairs.pair_failed", { symbol, error: message });
                    result = mode === "recent200"
                        ? {
                            symbol,
                            recent: emptyThinRecent(symbol),
                            status: "failed",
                            error: message,
                        }
                        : {
                            symbol,
                            regime: emptyThinRegime(symbol),
                            status: "failed",
                            error: message,
                        };
                }

                this.lastResults.push(result);
                if (this.lastResults.length <= RANK_PAIRS_RENDER_LIMIT) {
                    const liveRenderStartedAt = nowRankPairsMs();
                    this.appendResultRow(dom, result);
                    timingsMs.liveRender += nowRankPairsMs() - liveRenderStartedAt;
                }

                const percent = ((i + 1) / symbols.length) * 100;
                const progressStartedAt = nowRankPairsMs();
                this.setProgress(dom, percent, `${i + 1}/${symbols.length} (${symbol})`);
                timingsMs.progress += nowRankPairsMs() - progressStartedAt;

                // Yield periodically so long cached runs stay responsive without
                // paying one timer task per pair.
                if ((i + 1) % 128 === 0) {
                    const yieldStartedAt = nowRankPairsMs();
                    await taskYielder.yieldControl();
                    timingsMs.yield += nowRankPairsMs() - yieldStartedAt;
                }
            }

            if (token !== this.runToken) return;

            // On completion, re-render the list in the deterministic display
            // order in a single DocumentFragment so we pay one reflow, not N.
            // Skip on cancel — the streamed input-order rows stay as-is.
            if (!this.cancelled) {
                const sortStartedAt = nowRankPairsMs();
                const indexed = this.lastResults
                    .map((r, idx) => ({ r, idx }))
                    .sort((a, b) =>
                        compareAnyResultsForDisplay(a.r, b.r, a.idx, b.idx, mode)
                    );
                this.lastResults = indexed.map(({ r }) => r);
                timingsMs.sort += nowRankPairsMs() - sortStartedAt;
                const finalRenderStartedAt = nowRankPairsMs();
                const fragment = document.createDocumentFragment();
                for (const result of limitRankPairResultsForDisplay(this.lastResults)) {
                    fragment.appendChild(this.createResultRow(result));
                }
                dom.rankPairsResults.replaceChildren(fragment);
                timingsMs.finalRender += nowRankPairsMs() - finalRenderStartedAt;
            }

            setVisible(dom.rankPairsEmpty, this.lastResults.length === 0);
            dom.rankPairsStatus.textContent = this.cancelled
                ? `Stopped (${this.lastResults.length}/${symbols.length} pairs)`
                : prepared.reciprocalDuplicates > 0 || prepared.selfPairs > 0
                    ? `Done (${this.lastResults.length} relationships; ${prepared.reciprocalDuplicates} reciprocal duplicates skipped; ${prepared.selfPairs} self-pairs skipped)`
                    : `Done (${this.lastResults.length} relationships)`;
            if (this.lastResults.length > RANK_PAIRS_RENDER_LIMIT) {
                dom.rankPairsStatus.textContent +=
                    `; showing top ${RANK_PAIRS_RENDER_LIMIT.toLocaleString("en-US")} rows (Copy Results includes all)`;
            }

            this.lastDiagnostics = {
                totalPairs: symbols.length,
                processedPairs: this.lastResults.length,
                renderedPairs: Math.min(this.lastResults.length, RANK_PAIRS_RENDER_LIMIT),
                totalBars,
                elapsedMs: nowRankPairsMs() - runStartedAt,
                timingsMs,
                cacheDelta: buildRankPairsCacheDelta(
                    cacheBefore,
                    getBatchDatasetCacheStats(),
                ),
            };
            const recentCacheAfter = getRankPairsRecentLoaderStats();
            this.lastDiagnostics.cacheDelta.recentLegHits =
                recentCacheAfter.legHits - recentCacheBefore.legHits;
            this.lastDiagnostics.cacheDelta.recentLegMisses =
                recentCacheAfter.legMisses - recentCacheBefore.legMisses;
            dom.rankPairsDiagnostics.textContent =
                formatRankPairsPerformanceDiagnostics(this.lastDiagnostics);
            this.lastResultCount = this.lastResults.length;
            this.lastSummaryText = mode === "recent200"
                ? formatRecentOverallSummary(this.lastResults.filter(isRecentRankResult))
                : formatOverallSummary(this.lastResults.filter(
                    (result): result is RankResult => !isRecentRankResult(result),
                ));
            this.emitRunComplete(
                interval,
                symbols.length,
                startedAt,
                mode,
                this.lastDiagnostics,
            );

            if (!this.cancelled && this.lastResults.length > 0) {
                const completedStatusText = dom.rankPairsStatus.textContent ?? "";
                dom.rankPairsStatus.textContent =
                    `${completedStatusText}; saving result for reload…`;
                const persistenceStartedAt = nowRankPairsMs();
                try {
                    const snapshot = await saveLatestRankPairsResultSnapshot({
                        mode,
                        interval,
                        results: this.lastResults,
                        preview: limitRankPairResultsForDisplay(this.lastResults),
                        summaryText: this.lastSummaryText,
                        diagnosticsText: dom.rankPairsDiagnostics.textContent ?? "",
                        copyPreamble: mode === "recent200"
                            ? [RECENT_COPY_HEADER, RECENT_COPY_COLUMNS.join(" | ")]
                            : [COPY_HEADER, COPY_COLUMNS.join(" | ")],
                        serializeCopyRow: (result) => {
                            if (mode === "recent200" && isRecentRankResult(result)) {
                                return recentScalarRow(result);
                            }
                            if (!isRecentRankResult(result)) return scalarRow(result);
                            throw new Error("Rank Pairs result mode mismatch");
                        },
                    });
                    if (token !== this.runToken) return;
                    this.lastSnapshot = snapshot;
                    this.lastResults = snapshot.preview;
                    dom.rankPairsStatus.textContent =
                        `${completedStatusText}; saved for reload`;
                    debugLogger.event("rank_pairs.snapshot_saved", {
                        rows: snapshot.resultCount,
                        chunks: snapshot.chunkCount,
                        elapsedMs: nowRankPairsMs() - persistenceStartedAt,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    dom.rankPairsStatus.textContent = completedStatusText +
                        `; result persistence failed (${message}) — kept in memory`;
                    debugLogger.warn("rank_pairs.snapshot_save_failed", { error: message });
                }
            }
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.rankPairsStatus.textContent = `Error: ${message}`;
            debugLogger.error("rank_pairs.run_failed", { error: message });
        } finally {
            if (token === this.runToken) {
                dom.rankPairsRunBtn.disabled = false;
                dom.rankPairsMode.disabled = false;
                setVisible(dom.rankPairsStopBtn, false);
                dom.rankPairsCopyBtn.disabled = this.lastResultCount === 0;
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
                this.abortController = null;
            }
        }
    }

    private emitRunComplete(
        interval: string,
        _symbolCount: number,
        startedAt: number,
        mode: RankPairsMode,
        performance: RankPairsPerformanceDiagnostics,
    ): void {
        // One aggregate event per run — never one per pair, and never candles.
        // Counts by label let the debug panel summarize a run without re-running
        // the classifier.
        const ok = this.lastResults.filter((r) => r.status === "ok");
        const dirCounts: Record<string, number> = {};
        const structCounts: Record<string, number> = {};
        for (const r of ok) {
            if (isRecentRankResult(r)) {
                dirCounts[r.recent.direction] = (dirCounts[r.recent.direction] ?? 0) + 1;
                structCounts[`TYPE_${r.recent.type}`] =
                    (structCounts[`TYPE_${r.recent.type}`] ?? 0) + 1;
            } else {
                dirCounts[r.regime.direction] = (dirCounts[r.regime.direction] ?? 0) + 1;
                structCounts[r.regime.structure] = (structCounts[r.regime.structure] ?? 0) + 1;
            }
        }
        const failed = this.lastResults.filter((r) => r.status === "failed").length;
        debugLogger.event("rank_pairs.run_complete", {
            interval,
            mode,
            classified: ok.length,
            failed,
            cancelled: this.cancelled,
            elapsedMs: Date.now() - startedAt,
            byDirection: dirCounts,
            byStructure: structCounts,
            performance,
        });
    }

    private async copyResults(): Promise<void> {
        if (this.lastResultCount === 0) return;
        const dom = this.getDom();
        dom.rankPairsCopyBtn.disabled = true;
        dom.rankPairsStatus.textContent =
            `Preparing ${this.lastResultCount.toLocaleString("en-US")} saved rows for clipboard…`;
        try {
            const text = this.lastSnapshot
                ? await loadRankPairsSnapshotCopyText(this.lastSnapshot)
                : this.lastMode === "recent200"
                    ? formatRecentCopyText(this.lastResults.filter(isRecentRankResult))
                    : formatCopyText(this.lastResults.filter(
                        (result): result is RankResult => !isRecentRankResult(result),
                    ));
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

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    private appendResultRow(dom: RankPairsDom, result: AnyRankResult): void {
        dom.rankPairsResults.appendChild(this.createResultRow(result));
    }

    private clearStaleResults(dom: RankPairsDom): void {
        this.resultViewVersion += 1;
        if (this.lastResultCount === 0) return;
        this.lastResults = [];
        this.lastResultCount = 0;
        this.lastSummaryText = "";
        this.lastDiagnostics = null;
        this.lastSnapshot = null;
        dom.rankPairsCopyBtn.disabled = true;
        dom.rankPairsDiagnostics.textContent = "Performance diagnostics appear after a run.";
    }

    private async restoreLastResult(
        dom: RankPairsDom,
        resultViewVersion: number,
    ): Promise<void> {
        try {
            const snapshot =
                await loadLatestRankPairsResultSnapshot<AnyRankResult>();
            if (
                !snapshot
                || resultViewVersion !== this.resultViewVersion
                || this.lastResultCount > 0
            ) {
                return;
            }

            this.lastSnapshot = snapshot;
            this.lastResults = snapshot.preview;
            this.lastResultCount = snapshot.resultCount;
            this.lastSummaryText = snapshot.summaryText;
            this.lastMode = snapshot.mode;
            dom.rankPairsMode.value = snapshot.mode;

            const fragment = document.createDocumentFragment();
            for (const result of snapshot.preview) {
                fragment.appendChild(this.createResultRow(result));
            }
            dom.rankPairsResults.replaceChildren(fragment);
            setVisible(dom.rankPairsEmpty, snapshot.resultCount === 0);
            dom.rankPairsCopyBtn.disabled = snapshot.resultCount === 0;
            dom.rankPairsSummary.textContent = snapshot.summaryText;
            dom.rankPairsDiagnostics.textContent = snapshot.diagnosticsText;

            const completedAt = new Date(snapshot.completedAt).toLocaleString();
            dom.rankPairsStatus.textContent =
                `Restored ${snapshot.resultCount.toLocaleString("en-US")} rows from ${completedAt} (${snapshot.interval})`;
            if (snapshot.resultCount > snapshot.preview.length) {
                dom.rankPairsStatus.textContent +=
                    `; showing top ${snapshot.preview.length.toLocaleString("en-US")} rows (Copy Results includes all)`;
            }
            this.setProgress(dom, 100, "Restored");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLogger.warn("rank_pairs.snapshot_restore_failed", { error: message });
        }
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

    // --------------------------------------------------------------------
    // Progress / summary helpers
    // --------------------------------------------------------------------

    private setProgress(dom: RankPairsDom, percent: number, text: string): void {
        dom.rankPairsProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.rankPairsProgressText.textContent = text;
    }

    private resetProgress(dom: RankPairsDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.rankPairsStatus.textContent = "Idle";
    }

    private updateSummary(dom: RankPairsDom): void {
        if (this.lastResultCount > 0) {
            dom.rankPairsSummary.textContent = this.lastSummaryText;
            return;
        }
        const count = parseBatchSymbols(dom.rankPairsSymbols.value).length;
        dom.rankPairsSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
    }
}

function emptyThinRegime(symbol: string): PairRegimeResult {
    const regime = classifyPairRegime([]);
    regime.symbol = symbol;
    return regime;
}

function emptyThinRecent(symbol: string): RecentPairResult {
    const recent = classifyRecentPair([]);
    recent.symbol = symbol;
    return recent;
}

export const rankPairsService = new RankPairsService();
