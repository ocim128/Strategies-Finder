import { getRequiredElement, setVisible } from "../dom-utils";
import type { FinderResult } from "../types/finder";
import type { StrategyParams } from "../types/strategies";

export class FinderUI {
    private listElement: HTMLElement | null = null;
    private copyButton: HTMLButtonElement | null = null;
    private progressContainer: HTMLElement | null = null;
    private progressFill: HTMLElement | null = null;
    private progressLabel: HTMLElement | null = null;
    private statusElement: HTMLElement | null = null;
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
            title.textContent = item.name;

            const sub = document.createElement("div");
            sub.className = "finder-sub";
            sub.textContent = item.key;

            const params = document.createElement("div");
            params.className = "finder-params";
            params.textContent = this.formatParams(item.params);
            const metrics = document.createElement("div");
            metrics.className = "finder-metrics";
            const result = item.result;

            metrics.appendChild(this.createMetricChip(`Net ${this.formatCurrency(result.netProfit)}`));
            metrics.appendChild(this.createMetricChip(`PF ${this.formatProfitFactor(result.profitFactor)}`));
            metrics.appendChild(this.createMetricChip(`Sharpe ${result.sharpeRatio.toFixed(2)}`));
            metrics.appendChild(this.createMetricChip(`DD ${result.maxDrawdownPercent.toFixed(2)}%`));
            metrics.appendChild(this.createMetricChip(`Trades ${result.totalTrades}`));
            if (item.endpointAdjusted) {
                metrics.appendChild(this.createMetricChip(`Endpoint bias removed (${item.endpointRemovedTrades})`));
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
}
