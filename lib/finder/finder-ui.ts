import { getRequiredElement, setVisible } from "../dom-utils";
import type { FinderMode, FinderRandomBenchmark, FinderResult } from "../types/finder";
import type { BacktestResult, StrategyParams } from "../types/strategies";
import { getFinderSelectionResult } from "./finder-engine";

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
            const row = document.createElement("div");
            row.className = "finder-row";

            const rank = document.createElement("div");
            rank.className = "finder-rank";
            rank.textContent = `${index + 1}`;

            const main = document.createElement("div");
            main.className = "finder-main";

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

            const sub = document.createElement("div");
            sub.className = "finder-sub";
            const timeframeLabel = item.timeframes && item.timeframes.length === 1 ? ` @ ${item.timeframes[0]}` : "";
            sub.textContent = `${item.key}${timeframeLabel}`;

            const params = document.createElement("div");
            params.className = "finder-params";
            params.textContent = this.formatParams(item.params);
            const metrics = document.createElement("div");
            metrics.className = "finder-metrics";
            const result = getFinderDisplayResult(item);

            // Polymarket mode: show classification metrics instead of PnL
            if (item.polymarketEval) {
                const poly = item.polymarketEval;
                metrics.appendChild(this.createMetricChip(`Poly Win ${(poly.winRate * 100).toFixed(1)}%`));
                if (typeof poly.expectancy === "number" && Number.isFinite(poly.expectancy)) {
                    metrics.appendChild(this.createMetricChip(`Poly Exp ${this.formatPolymarketCents(poly.expectancy)}`));
                }
                metrics.appendChild(this.createMetricChip(`Poly PF ${this.formatOptionalProfitFactor(poly.profitFactor)}`));
                metrics.appendChild(this.createMetricChip(`Coverage ${(poly.coverage * 100).toFixed(1)}%`));
                metrics.appendChild(this.createMetricChip(`Wins ${poly.wins}`));
                metrics.appendChild(this.createMetricChip(`Scored ${poly.scoredPredictions}`));
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
                metrics.appendChild(this.createMetricChip(`PF ${this.formatProfitFactor(result.profitFactor)}`));
                metrics.appendChild(this.createMetricChip(`Sharpe ${result.sharpeRatio.toFixed(2)}`));
                if (Number.isFinite(item.compositeEdgeRatio)) {
                    metrics.appendChild(this.createMetricChip(`ER ${item.compositeEdgeRatio!.toFixed(2)}`));
                }
                metrics.appendChild(this.createMetricChip(`DD ${result.maxDrawdownPercent.toFixed(2)}%`));
                metrics.appendChild(this.createMetricChip(`Trades ${result.totalTrades}`));
                if (item.endpointAdjusted) {
                    metrics.appendChild(this.createMetricChip(this.formatSelectionSummary(result)));
                    metrics.appendChild(this.createMetricChip(`Endpoint bias removed (${item.endpointRemovedTrades})`));
                }
            }

            main.appendChild(title);
            main.appendChild(sub);
            main.appendChild(params);
            main.appendChild(metrics);

            const button = document.createElement("button");
            button.className = "btn btn-secondary finder-apply";
            button.textContent = "Apply";
            button.dataset.index = index.toString();

            row.appendChild(rank);
            row.appendChild(main);
            row.appendChild(button);
            fragment.appendChild(row);
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

    private formatParams(params: StrategyParams): string {
        return Object.entries(params)
            .map(([key, value]) => `${key}=${this.formatParamValue(value)}`)
            .join(", ");
    }

    private formatParamValue(value: number): string {
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    }

    private formatCurrency(value: number): string {
        const sign = value >= 0 ? "+" : "";
        return `${sign}$${value.toFixed(2)}`;
    }

    private formatProfitFactor(value: number): string {
        return value === Infinity ? "Inf" : value.toFixed(2);
    }

    private formatOptionalProfitFactor(value: number | undefined): string {
        if (value === undefined || value === null || Number.isNaN(value)) {
            return "n/a";
        }
        return value === Infinity ? "Inf" : value.toFixed(2);
    }

    private formatPolymarketCents(value: number): string {
        const sign = value > 0 ? "+" : value < 0 ? "-" : "";
        return `${sign}${(Math.abs(value) * 100).toFixed(1)}c`;
    }

    private formatSelectionSummary(result: BacktestResult): string {
        return `Selection ${this.formatCurrency(result.netProfit)} • ${result.totalTrades} trades`;
    }
}
