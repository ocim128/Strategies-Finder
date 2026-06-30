/**
 * Rank Pairs UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/batch-backtest/batch-backtest-service.ts`). Binds the tab's buttons,
 * reads the CURRENT chart interval once per run, fetches each pair's OHLCV via
 * the shared batch loader (so shared synthetic legs are deduped), and scores
 * each pair with the pure `scoreRelativeStrength` helper.
 *
 * Output rows mirror Batch Backtest's `finder-symbol-row` shape with a verdict
 * badge + pipe-formatted metrics, so a Rank run reads the same as a Batch run.
 *
 * ⚠ Research only: scores use full-window return (lookahead bias). Surfaced in
 * the tab's hint banner.
 */

import { state } from "../state";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { parseBatchSymbols } from "../batch-backtest/batch-backtest-runner";
import { loadBatchDataset } from "../batch-backtest/batch-backtest-loader";
import { createRankPairsDom, type RankPairsDom } from "./rank-pairs-dom";
import {
    formatPercent,
    scoreRelativeStrength,
    type RankVerdict,
    type RelativeStrengthScore,
} from "./relative-strength-score";

interface RankResult {
    symbol: string;
    score: RelativeStrengthScore;
    status: "ok" | "no_data" | "failed";
    error?: string;
}

const VERDICT_LABEL: Record<RankVerdict, string> = {
    STRONG_BASE: "STRONG",
    SOLID_BASE: "SOLID",
    FLAT: "FLAT",
    WEAK_BASE: "WEAK",
    THIN: "THIN",
};

// Reuse Batch Backtest / Finder verdict CSS classes (single hyphen) so the
// badges pick up the existing palette without new styles.
const VERDICT_CSS_CLASS: Record<RankVerdict, string> = {
    STRONG_BASE: "finder-verdict-strong",
    SOLID_BASE: "finder-verdict-solid",
    FLAT: "finder-verdict-marginal",
    WEAK_BASE: "finder-verdict-losing",
    THIN: "finder-verdict-thin",
};

function verdictForError(status: RankResult["status"]): { label: string; cssClass: string } {
    if (status === "no_data") return { label: "THIN", cssClass: VERDICT_CSS_CLASS.THIN };
    return { label: "FAIL", cssClass: "finder-verdict-losing" };
}

function formatResultRowPipe(result: RankResult): string {
    const { score } = result;
    const parts = [
        `RS ${formatPercent(score.ratioReturn)}`,
        `Ann ${formatPercent(score.annualizedReturn)}`,
        `Bars ${score.bars}`,
    ];
    return parts.join(" | ");
}

function formatOverallSummary(results: RankResult[]): string {
    const scored = results.filter((r) => r.status === "ok");
    const counts: Record<RankVerdict, number> = {
        STRONG_BASE: 0, SOLID_BASE: 0, FLAT: 0, WEAK_BASE: 0, THIN: 0,
    };
    for (const r of scored) counts[r.score.verdict] += 1;
    const failed = results.filter((r) => r.status === "failed").length;
    return [
        `Pairs ${results.length}`,
        `STRONG ${counts.STRONG_BASE}`,
        `SOLID ${counts.SOLID_BASE}`,
        `FLAT ${counts.FLAT}`,
        `WEAK ${counts.WEAK_BASE}`,
        `THIN ${counts.THIN}`,
        `FAILED ${failed}`,
    ].join(" | ");
}

function formatCopyText(results: RankResult[]): string {
    const lines = ["PAIR | RATIO_RET | ANN_RET | BARS | VERDICT"];
    for (const r of [...results].sort((a, b) => {
        const ar = Number.isFinite(a.score.ratioReturn) ? a.score.ratioReturn : -Infinity;
        const br = Number.isFinite(b.score.ratioReturn) ? b.score.ratioReturn : -Infinity;
        return br - ar;
    })) {
        const v = r.status === "ok" ? VERDICT_LABEL[r.score.verdict] : r.status.toUpperCase();
        lines.push(
            `${r.symbol} | ${formatPercent(r.score.ratioReturn)} | ${formatPercent(r.score.annualizedReturn)} | ${r.score.bars} | ${v}`,
        );
    }
    return lines.join("\n");
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
                        const score = scoreRelativeStrength(bars, interval);
                        result = { symbol, score, status: score.bars < 200 ? "no_data" : "ok" };
                    } else {
                        result = {
                            symbol,
                            score: { ratioReturn: NaN, annualizedReturn: NaN, bars: bars.length, verdict: "THIN" },
                            status: "no_data",
                        };
                    }
                } catch (error) {
                    if (token !== this.runToken) return;
                    const message = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("rank_pairs.pair_failed", { symbol, error: message });
                    result = {
                        symbol,
                        score: { ratioReturn: NaN, annualizedReturn: NaN, bars: 0, verdict: "THIN" },
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

            // On completion, re-render the list sorted by ratio return (strongest
            // first) in a single DocumentFragment so we pay one reflow, not N.
            // Skip on cancel — the streamed input-order rows stay as-is.
            if (!this.cancelled) {
                this.lastResults.sort((a, b) => {
                    const ar = Number.isFinite(a.score.ratioReturn) ? a.score.ratioReturn : -Infinity;
                    const br = Number.isFinite(b.score.ratioReturn) ? b.score.ratioReturn : -Infinity;
                    return br - ar;
                });
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
        if (result.status === "ok") {
            badge.className = `finder-verdict ${VERDICT_CSS_CLASS[result.score.verdict]}`;
            badge.textContent = VERDICT_LABEL[result.score.verdict];
        } else {
            const v = verdictForError(result.status);
            badge.className = `finder-verdict ${v.cssClass}`;
            badge.textContent = v.label;
        }
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

export const rankPairsService = new RankPairsService();
