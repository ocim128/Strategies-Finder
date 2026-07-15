/**
 * Rank Pairs UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/batch-backtest/batch-backtest-service.ts`). Binds the tab's buttons,
 * reads the CURRENT chart interval once per run, fetches each pair's OHLCV via
 * the shared batch loader (so shared synthetic legs are deduped), and
 * classifies each pair with the pure `classifyPairRegime` helper.
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
import { parseBatchSymbols } from "../batch-backtest/batch-backtest-runner";
import { loadBatchDataset } from "../batch-backtest/batch-backtest-loader";
import { createRankPairsDom, type RankPairsDom } from "./rank-pairs-dom";
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

/** A ranked pair row. Exported for service-level copy/summary tests. */
export interface RankResult {
    symbol: string;
    regime: PairRegimeResult;
    status: "ok" | "no_data" | "failed";
    error?: string;
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

class RankPairsService {
    private dom: RankPairsDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: RankResult[] = [];
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
    }

    private async runRank(): Promise<void> {
        const dom = this.getDom();
        const symbols = parseBatchSymbols(dom.rankPairsSymbols.value);
        if (symbols.length === 0) {
            dom.rankPairsStatus.textContent = "Add at least one pair.";
            return;
        }

        const interval = state.currentInterval;
        const startedAt = Date.now();

        this.runToken += 1;
        const token = this.runToken;
        this.cancelled = false;
        this.lastResults = [];
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        dom.rankPairsRunBtn.disabled = true;
        setVisible(dom.rankPairsStopBtn, true);
        dom.rankPairsCopyBtn.disabled = true;
        setVisible(dom.rankPairsEmpty, false);
        dom.rankPairsResults.replaceChildren();

        try {
            for (let i = 0; i < symbols.length; i += 1) {
                if (token !== this.runToken || this.cancelled) break;
                const symbol = symbols[i];

                let result: RankResult;
                try {
                    const bars = await loadBatchDataset(symbol, interval, signal);
                    if (token !== this.runToken) return;
                    if (!signal.aborted && bars.length > 0) {
                        const regime = classifyPairRegime(bars);
                        regime.symbol = symbol;
                        // The classifier returns THIN with an INSUFFICIENT_*
                        // reason when coverage fails; surface those as no_data
                        // rows distinct from genuine classifications.
                        const isThin =
                            regime.direction === "THIN" && regime.reason !== "OK";
                        result = { symbol, regime, status: isThin ? "no_data" : "ok" };
                    } else {
                        result = {
                            symbol,
                            regime: emptyThinRegime(symbol),
                            status: "no_data",
                        };
                    }
                } catch (error) {
                    if (token !== this.runToken) return;
                    const message = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("rank_pairs.pair_failed", { symbol, error: message });
                    result = {
                        symbol,
                        regime: emptyThinRegime(symbol),
                        status: "failed",
                        error: message,
                    };
                }

                this.lastResults.push(result);
                this.appendResultRow(dom, result);

                const percent = ((i + 1) / symbols.length) * 100;
                this.setProgress(dom, percent, `${i + 1}/${symbols.length} (${symbol})`);

                // Yield to the event loop between pairs so the UI stays
                // responsive during long lists, matching the batch runner.
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }

            if (token !== this.runToken) return;

            // On completion, re-render the list in the deterministic display
            // order in a single DocumentFragment so we pay one reflow, not N.
            // Skip on cancel — the streamed input-order rows stay as-is.
            if (!this.cancelled) {
                const indexed = this.lastResults
                    .map((r, idx) => ({ r, idx }))
                    .sort((a, b) => compareRankResultsForDisplay(a.r, b.r, a.idx, b.idx));
                this.lastResults = indexed.map(({ r }) => r);
                const fragment = document.createDocumentFragment();
                for (const result of this.lastResults) {
                    fragment.appendChild(this.createResultRow(result));
                }
                dom.rankPairsResults.replaceChildren(fragment);
            }

            setVisible(dom.rankPairsEmpty, this.lastResults.length === 0);
            dom.rankPairsStatus.textContent = this.cancelled
                ? `Stopped (${this.lastResults.length}/${symbols.length} pairs)`
                : `Done (${this.lastResults.length} pairs)`;

            this.emitRunComplete(interval, symbols.length, startedAt);
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.rankPairsStatus.textContent = `Error: ${message}`;
            debugLogger.error("rank_pairs.run_failed", { error: message });
        } finally {
            if (token === this.runToken) {
                dom.rankPairsRunBtn.disabled = false;
                setVisible(dom.rankPairsStopBtn, false);
                dom.rankPairsCopyBtn.disabled = this.lastResults.length === 0;
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
    ): void {
        // One aggregate event per run — never one per pair, and never candles.
        // Counts by label let the debug panel summarize a run without re-running
        // the classifier.
        const ok = this.lastResults.filter((r) => r.status === "ok");
        const dirCounts: Record<string, number> = {};
        const structCounts: Record<string, number> = {};
        for (const r of ok) {
            dirCounts[r.regime.direction] = (dirCounts[r.regime.direction] ?? 0) + 1;
            structCounts[r.regime.structure] = (structCounts[r.regime.structure] ?? 0) + 1;
        }
        const failed = this.lastResults.filter((r) => r.status === "failed").length;
        debugLogger.event("rank_pairs.run_complete", {
            interval,
            classified: ok.length,
            failed,
            cancelled: this.cancelled,
            elapsedMs: Date.now() - startedAt,
            byDirection: dirCounts,
            byStructure: structCounts,
        });
    }

    private async copyResults(): Promise<void> {
        if (this.lastResults.length === 0) return;
        const text = formatCopyText(this.lastResults);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard can fail in non-secure contexts; fall back silently.
        }
    }

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    private appendResultRow(dom: RankPairsDom, result: RankResult): void {
        dom.rankPairsResults.appendChild(this.createResultRow(result));
    }

    private clearStaleResults(dom: RankPairsDom): void {
        if (this.lastResults.length === 0) return;
        this.lastResults = [];
        dom.rankPairsCopyBtn.disabled = true;
    }

    private createResultRow(result: RankResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";

        const badge = document.createElement("span");
        badge.className = `finder-verdict ${badgeCssFor(result)}`;
        badge.textContent = badgeLabelFor(result);
        line.appendChild(badge);

        line.appendChild(document.createTextNode(` ${result.symbol} | ${formatResultRowPipe(result)}`));
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
        if (this.lastResults.length > 0) {
            dom.rankPairsSummary.textContent = formatOverallSummary(this.lastResults);
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

export const rankPairsService = new RankPairsService();
