import { getRequiredElement, setVisible } from "../dom-utils";
import type { FinderResult } from "../types/finder";
import type { StrategyParams } from "../types/strategies";

export class FinderUI {
    public renderResults(results: FinderResult[]): void {
        const list = getRequiredElement("finderList");
        const copyButton = document.getElementById("finderCopyTopResults") as HTMLButtonElement | null;
        list.innerHTML = "";

        if (results.length === 0) {
            setVisible("finderEmpty", true);
            if (copyButton) copyButton.disabled = true;
            return;
        }

        setVisible("finderEmpty", false);
        if (copyButton) copyButton.disabled = false;

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
            const selection = item.selectionResult;

            metrics.appendChild(this.createMetricChip(`Net ${this.formatCurrency(selection.netProfit)}`));
            metrics.appendChild(this.createMetricChip(`PF ${this.formatProfitFactor(selection.profitFactor)}`));
            metrics.appendChild(this.createMetricChip(`Sharpe ${selection.sharpeRatio.toFixed(2)}`));
            metrics.appendChild(this.createMetricChip(`DD ${selection.maxDrawdownPercent.toFixed(2)}%`));
            metrics.appendChild(this.createMetricChip(`Trades ${selection.totalTrades}`));
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
            list.appendChild(row);
        });
    }

    public setProgress(active: boolean, percent: number, text: string): void {
        const container = getRequiredElement("finderProgress");
        const fill = getRequiredElement("finderProgressFill");
        const label = getRequiredElement("finderProgressText");
        container.classList.toggle("active", active);
        fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        label.textContent = text;
    }

    public setStatus(text: string): void {
        getRequiredElement("finderStatus").textContent = text;
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
