import { getRequiredElement, setVisible } from "../dom-utils";
import {
    formatPolymarketCents,
    formatProfitFactor,
    formatSignedCompactDollar,
} from "../ui-formatters";
import type { FinderMode, FinderRandomBenchmark, FinderResult, FinderUniverseCandidate } from "../types/finder";
import type { BacktestResult, StrategyParams, Time } from "../types/strategies";
import { getFinderSelectionResult } from "./finder-engine";
import { computePerformanceVerdict, computeStrategyVerdict } from "./finder-universe-metrics";

export function getFinderDisplayResult(item: FinderResult): BacktestResult {
    return getFinderSelectionResult(item);
}

export class FinderUI {
    private listElement: HTMLElement | null = null;
    private copyButton: HTMLButtonElement | null = null;
    private progressContainer: HTMLElement | null = null;
    private progressFill: HTMLElement | null = null;
    private progressLabel: HTMLElement | null = null;
    private statusElement: HTMLElement | null = null;
    private benchmarkContainer: HTMLElement | null = null;
    private benchmarkBody: HTMLElement | null = null;
    private lastProgressActive: boolean | null = null;
    private lastProgressPercent = -1;
    private lastProgressText = "";
    private lastStatusText = "";

    private getListElement(): HTMLElement {
        if (!this.listElement) {
            this.listElement = getRequiredElement("finderList");
        }
        return this.listElement;
    }

    private getCopyButton(): HTMLButtonElement | null {
        if (!this.copyButton) {
            this.copyButton = document.getElementById("finderCopyTopResults") as HTMLButtonElement | null;
        }
        return this.copyButton;
    }

    private getProgressElements(): { container: HTMLElement; fill: HTMLElement; label: HTMLElement } {
        if (!this.progressContainer) {
            this.progressContainer = getRequiredElement("finderProgress");
        }
        if (!this.progressFill) {
            this.progressFill = getRequiredElement("finderProgressFill");
        }
        if (!this.progressLabel) {
            this.progressLabel = getRequiredElement("finderProgressText");
        }
        return {
            container: this.progressContainer,
            fill: this.progressFill,
            label: this.progressLabel
        };
    }

    private getStatusElement(): HTMLElement {
        if (!this.statusElement) {
            this.statusElement = getRequiredElement("finderStatus");
        }
        return this.statusElement;
    }

    private getBenchmarkElements(): { container: HTMLElement; body: HTMLElement } {
        if (!this.benchmarkContainer) {
            this.benchmarkContainer = getRequiredElement("finderBenchmark");
        }
        if (!this.benchmarkBody) {
            this.benchmarkBody = getRequiredElement("finderBenchmarkBody");
        }
        return {
            container: this.benchmarkContainer,
            body: this.benchmarkBody
        };
    }

    public renderResults(results: FinderResult[]): void {
        const list = this.getListElement();
        const copyButton = this.getCopyButton();
        list.innerHTML = "";

        if (results.length === 0) {
            setVisible("finderEmpty", true);
            if (copyButton) copyButton.disabled = true;
            return;
        }

        setVisible("finderEmpty", false);
        if (copyButton) copyButton.disabled = false;

        const fragment = document.createDocumentFragment();
        results.forEach((item, index) => {
            const title = document.createElement("div");
            title.className = "finder-title";
            const titleText = document.createElement("span");
            titleText.textContent = item.name;
            title.appendChild(titleText);
            if (item.comboMode) {
                const comboBadge = document.createElement("span");
                comboBadge.className = "finder-title-badge finder-title-badge-combo";
                comboBadge.textContent = "COMBO";
                title.appendChild(comboBadge);
            }

            const timeframeLabel = item.timeframes && item.timeframes.length === 1 ? ` @ ${item.timeframes[0]}` : "";
            const metrics = document.createElement("div");
            metrics.className = "finder-metrics";
            const result = getFinderDisplayResult(item);

            // Polymarket mode: show classification metrics instead of PnL
            if (item.polymarketEval) {
                const poly = item.polymarketEval;
                metrics.appendChild(this.createMetricChip(`Poly Win ${(poly.winRate * 100).toFixed(1)}%`));
                if (typeof poly.expectancy === "number" && Number.isFinite(poly.expectancy)) {
                    metrics.appendChild(this.createMetricChip(`Poly Exp ${formatPolymarketCents(poly.expectancy)}`));
                }
                metrics.appendChild(this.createMetricChip(`Poly PF ${formatProfitFactor(poly.profitFactor)}`));
                if (typeof poly.sizedNetProfit === "number") {
                    metrics.appendChild(this.createMetricChip(`Sized Net ${formatSignedCompactDollar(poly.sizedNetProfit)}`));
                }
                metrics.appendChild(this.createMetricChip(`Coverage ${(poly.coverage * 100).toFixed(1)}%`));
                metrics.appendChild(this.createMetricChip(`Wins ${poly.wins}`));
                metrics.appendChild(this.createMetricChip(`Scored ${poly.scoredPredictions}`));
                if (poly.limitEntryEnabled) {
                    metrics.appendChild(this.createMetricChip(`Filled ${poly.limitEntryFilledTrades ?? 0}/${poly.limitEntryAttempts ?? 0}`));
                    metrics.appendChild(this.createMetricChip(`Missed ${poly.limitEntryMissedTrades ?? 0}`));
                    if (typeof poly.limitEntryFillRate === "number") {
                        metrics.appendChild(this.createMetricChip(`Fill ${(poly.limitEntryFillRate * 100).toFixed(1)}%`));
                    }
                    if (poly.limitExitEnabled) {
                        metrics.appendChild(this.createMetricChip(`Exit ${poly.limitExitFilledTrades ?? 0}`));
                    }
                }
                if (poly.predictionsTaken !== poly.scoredPredictions) {
                    metrics.appendChild(this.createMetricChip(`Taken ${poly.predictionsTaken}`));
                }
                if (poly.missingOutcomeRows > 0) {
                    metrics.appendChild(this.createMetricChip(`Miss ${poly.missingOutcomeRows}`));
                }
                if (poly.alwaysYesBaselineWinRate !== undefined) {
                    metrics.appendChild(this.createMetricChip(`BaseY ${(poly.alwaysYesBaselineWinRate * 100).toFixed(1)}%`));
                }
            } else {
                metrics.appendChild(this.createMetricChip(`Net ${this.formatCurrency(result.netProfit)}`));
                metrics.appendChild(this.createMetricChip(`PF ${formatProfitFactor(result.profitFactor)}`));
                metrics.appendChild(this.createMetricChip(`Sharpe ${result.sharpeRatio.toFixed(2)}`));
                if (Number.isFinite(item.compositeEdgeRatio)) {
                    metrics.appendChild(this.createMetricChip(`ER ${item.compositeEdgeRatio!.toFixed(2)}`));
                }
                if (typeof result.tradeTimingQuality?.entryScore === "number") {
                    metrics.appendChild(this.createMetricChip(`Entry ${this.formatScore(result.tradeTimingQuality.entryScore)}`));
                }
                if (typeof result.tradeTimingQuality?.exitScore === "number") {
                    metrics.appendChild(this.createMetricChip(`Exit ${this.formatScore(result.tradeTimingQuality.exitScore)}`));
                }
                metrics.appendChild(this.createMetricChip(`DD ${result.maxDrawdownPercent.toFixed(2)}%`));
                metrics.appendChild(this.createMetricChip(`Trades ${result.totalTrades}`));
                if (item.endpointAdjusted) {
                    metrics.appendChild(this.createMetricChip(this.formatSelectionSummary(result)));
                    metrics.appendChild(this.createMetricChip(`Endpoint bias removed (${item.endpointRemovedTrades})`));
                }
            }

            fragment.appendChild(this.createResultRow({
                index,
                title,
                subText: `${item.key}${timeframeLabel}`,
                paramsText: this.formatParams(item.params),
                detailLines: this.formatDetailLines(item),
                metrics,
            }));
        });
        list.appendChild(fragment);
    }

    public renderUniverseResults(results: FinderUniverseCandidate[]): void {
        const list = this.getListElement();
        const copyButton = this.getCopyButton();
        list.innerHTML = "";

        if (results.length === 0) {
            setVisible("finderEmpty", true);
            if (copyButton) copyButton.disabled = true;
            return;
        }

        setVisible("finderEmpty", false);
        if (copyButton) copyButton.disabled = false;

        const fragment = document.createDocumentFragment();
        results.forEach((item, index) => {
            const title = document.createElement("div");
            title.className = "finder-title";
            title.textContent = item.strategyName;

            const metrics = document.createElement("div");
            metrics.className = "finder-metrics";
            metrics.appendChild(this.createMetricChip(`Ratio ${(item.profitableActiveRatio * 100).toFixed(1)}%`));
            metrics.appendChild(this.createMetricChip(`Active ${item.activeSymbols}`));
            metrics.appendChild(this.createMetricChip(`No Trade ${item.noTradeSymbols}`));
            metrics.appendChild(this.createMetricChip(`Med Exp ${item.medianExpectancy.toFixed(2)}`));
            metrics.appendChild(this.createMetricChip(`Med Sharpe ${item.medianSharpe.toFixed(2)}`));
            metrics.appendChild(this.createMetricChip(`Med PF ${formatProfitFactor(item.medianProfitFactor)}`));
            metrics.appendChild(this.createMetricChip(`Worst ${this.formatCurrency(item.worstNetProfit)}`));
            metrics.appendChild(this.createMetricChip(`Trades ${item.totalTrades}`));

            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = `Symbol Breakdown (${item.symbols.length})`;
            details.appendChild(summary);

            // Sort symbols: best performers first so hidden green surfaces
            const sortedSymbols = [...item.symbols].sort((a, b) => {
                const va = computePerformanceVerdict(a.result, a.status);
                const vb = computePerformanceVerdict(b.result, b.status);
                if (va.tier !== vb.tier) return va.tier - vb.tier;
                return (b.result?.expectancy ?? -Infinity) - (a.result?.expectancy ?? -Infinity);
            });

            // Verdict distribution summary
            const verdictCounts = new Map<string, number>();
            for (const s of sortedSymbols) {
                const v = computePerformanceVerdict(s.result, s.status);
                verdictCounts.set(v.label, (verdictCounts.get(v.label) ?? 0) + 1);
            }
            const summaryLine = document.createElement("div");
            summaryLine.className = "finder-universe-summary";
            const summaryParts: string[] = [];
            for (const label of ["STRONG", "SOLID", "MARGINAL", "WEAK", "LOSING", "THIN", "NO SIGNAL"]) {
                const count = verdictCounts.get(label);
                if (count) summaryParts.push(`${count} ${label}`);
            }
            summaryLine.textContent = summaryParts.join(" • ");
            details.appendChild(summaryLine);

            for (const symbolResult of sortedSymbols) {
                const line = document.createElement("div");
                line.className = "finder-sub finder-symbol-row";
                const verdict = computePerformanceVerdict(symbolResult.result, symbolResult.status);
                const badge = document.createElement("span");
                badge.className = `finder-verdict ${verdict.cssClass}`;
                badge.textContent = verdict.label;
                line.appendChild(badge);

                const textParts: string[] = [symbolResult.symbol];
                textParts.push(this.formatUniverseStatus(symbolResult.status));
                textParts.push(`Bars ${symbolResult.barCount}`);
                if (symbolResult.result) {
                    const r = symbolResult.result;
                    textParts.push(`Net ${this.formatCurrency(r.netProfit)}`);
                    textParts.push(`Exp ${r.expectancy.toFixed(2)}`);
                    textParts.push(`PF ${formatProfitFactor(r.profitFactor)}`);
                    textParts.push(`WR ${r.winRate.toFixed(0)}%`);
                    textParts.push(`Sharpe ${r.sharpeRatio.toFixed(2)}`);
                    textParts.push(`DD ${r.maxDrawdownPercent.toFixed(2)}%`);
                    textParts.push(`Trades ${r.totalTrades}`);
                }
                if (symbolResult.error) textParts.push(symbolResult.error);
                const timeRange = this.formatUniverseTimeRange(symbolResult.firstTime, symbolResult.lastTime);
                if (timeRange) textParts.push(timeRange.replace(/^ \| /, ""));

                const textSpan = document.createElement("span");
                textSpan.textContent = textParts.join(" | ");
                line.appendChild(textSpan);
                details.appendChild(line);
            }

            fragment.appendChild(this.createResultRow({
                index,
                title,
                subText: `${item.strategyKey} | ${item.profitableSymbols}/${item.activeSymbols} profitable active symbols${this.formatStrategyVerdictSuffix(item.profitableActiveRatio)}`,
                paramsText: this.formatParams(item.params),
                metrics,
                details,
            }));
        });
        list.appendChild(fragment);
    }

    public setProgress(active: boolean, percent: number, text: string): void {
        const normalizedPercent = Math.min(100, Math.max(0, percent));
        if (
            this.lastProgressActive === active &&
            Math.abs(this.lastProgressPercent - normalizedPercent) < 0.01 &&
            this.lastProgressText === text
        ) {
            return;
        }

        const { container, fill, label } = this.getProgressElements();
        container.classList.toggle("active", active);
        fill.style.width = `${normalizedPercent}%`;
        label.textContent = text;
        this.lastProgressActive = active;
        this.lastProgressPercent = normalizedPercent;
        this.lastProgressText = text;
    }

    public setStatus(text: string): void {
        if (this.lastStatusText === text) return;
        this.getStatusElement().textContent = text;
        this.lastStatusText = text;
    }

    public renderRandomBenchmark(mode: FinderMode, benchmark?: FinderRandomBenchmark): void {
        const { container, body } = this.getBenchmarkElements();
        if (mode !== "random" || !benchmark) {
            container.style.display = "none";
            body.textContent = "";
            return;
        }

        const coveragePct = (benchmark.shortCoverage * 100).toFixed(1);
        body.innerHTML = `
            <div class="finder-benchmark-grid">
                <span><strong>Pipeline:</strong> ${benchmark.pipeline}</span>
                <span><strong>Engine:</strong> ${benchmark.engineMode}</span>
                <span><strong>Throughput:</strong> ${benchmark.runsPerSecond.toFixed(2)} runs/s</span>
                <span><strong>Cost:</strong> ${benchmark.msPerRun.toFixed(2)} ms/run</span>
                <span><strong>Runs:</strong> ${benchmark.processedRuns}/${benchmark.totalRuns}</span>
                <span><strong>Stages:</strong> pre ${benchmark.prescreenRuns}, short ${benchmark.shortlistRuns}, full ${benchmark.fullRuns}</span>
                <span><strong>Short slice:</strong> ${benchmark.shortBars} bars (${coveragePct}%)</span>
                <span><strong>Shown:</strong> ${benchmark.shown}</span>
            </div>
        `;
        container.style.display = "";
    }

    private createMetricChip(text: string): HTMLSpanElement {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
    }

    private createResultRow(options: {
        index: number;
        title: HTMLElement;
        subText: string;
        paramsText: string;
        metrics: HTMLElement;
        detailLines?: string[];
        details?: HTMLElement;
    }): HTMLDivElement {
        const row = document.createElement("div");
        row.className = "finder-row";

        const rank = document.createElement("div");
        rank.className = "finder-rank";
        rank.textContent = `${options.index + 1}`;

        const main = document.createElement("div");
        main.className = "finder-main";

        const sub = document.createElement("div");
        sub.className = "finder-sub";
        sub.textContent = options.subText;

        const params = document.createElement("div");
        params.className = "finder-params";
        params.textContent = options.paramsText;

        main.appendChild(options.title);
        main.appendChild(sub);
        main.appendChild(params);
        for (const detailLine of options.detailLines ?? []) {
            const detail = document.createElement("div");
            detail.className = "finder-sub";
            detail.textContent = detailLine;
            main.appendChild(detail);
        }
        main.appendChild(options.metrics);
        if (options.details) {
            main.appendChild(options.details);
        }

        const button = document.createElement("button");
        button.className = "btn btn-secondary finder-apply";
        button.textContent = "Apply";
        button.dataset.index = options.index.toString();

        row.appendChild(rank);
        row.appendChild(main);
        row.appendChild(button);
        return row;
    }

    private formatParams(params: StrategyParams): string {
        return Object.entries(params)
            .map(([key, value]) => `${key}=${this.formatParamValue(value)}`)
            .join(", ");
    }

    private formatDetailLines(item: FinderResult): string[] {
        if (!item.exitStrategyKey) return [];
        const exitParams = item.exitStrategyParams ? this.formatParams(item.exitStrategyParams) : "";
        return [
            exitParams
                ? `Exit override: ${item.exitStrategyKey} (${exitParams})`
                : `Exit override: ${item.exitStrategyKey}`,
        ];
    }

    private formatParamValue(value: number): string {
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    }

    private formatCurrency(value: number): string {
        const sign = value >= 0 ? "+" : "";
        return `${sign}$${value.toFixed(2)}`;
    }

    private formatUniverseStatus(status: string): string {
        switch (status) {
            case "profitable":
                return "Profitable";
            case "losing":
                return "Losing";
            case "flat":
                return "Flat";
            case "no_trades":
                return "No Trades";
            case "load_failed":
                return "Load Failed";
            case "run_failed":
                return "Run Failed";
            default:
                return status;
        }
    }

    private formatUniverseTimeRange(firstTime?: Time, lastTime?: Time): string {
        if (!firstTime && !lastTime) {
            return "";
        }
        const firstLabel = firstTime ? this.formatTime(firstTime) : "?";
        const lastLabel = lastTime ? this.formatTime(lastTime) : "?";
        return ` | ${firstLabel} -> ${lastLabel}`;
    }

    private formatTime(time: Time): string {
        if (typeof time === "string") {
            return time;
        }
        if (typeof time === "number") {
            const timestampMs = time > 1_000_000_000_000 ? time : time * 1000;
            return new Date(timestampMs).toISOString().slice(0, 10);
        }
        if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
            const month = String(time.month).padStart(2, "0");
            const day = String(time.day).padStart(2, "0");
            return `${time.year}-${month}-${day}`;
        }
        return String(time);
    }

    private formatScore(value: number): string {
        return Number.isInteger(value) ? value.toString() : value.toFixed(1);
    }

    private formatSelectionSummary(result: BacktestResult): string {
        return `Selection ${this.formatCurrency(result.netProfit)} • ${result.totalTrades} trades`;
    }

    private formatStrategyVerdictSuffix(ratio: number): string {
        const verdict = computeStrategyVerdict(ratio);
        return ` | ${verdict.label}`;
    }
}
