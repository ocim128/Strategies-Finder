import { createPolymarketPanelDom, type PolymarketPanelDom } from "./feature-dom-contracts";
import { isSupportedPolymarketBtc5mRun, loadBtc5mPolymarketOutcomesForTimeRange } from "./polymarket-btc5m";
import { analyzePolymarketFillability, type PolymarketFillScope } from "./polymarket-fill-analysis";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { state } from "./state";
import { setVisible } from "./dom-utils";
import type { BacktestResult } from "./types/strategies";
import type { PolymarketOutcomeRow } from "./types/polymarket-outcomes";

class PolymarketPanelService {
    private dom: PolymarketPanelDom | null = null;
    private initialized = false;
    private outcomeByStartTs = new Map<number, PolymarketOutcomeRow>();
    private lastResult: BacktestResult | null = null;
    private isLoading = false;
    private loadError: string | null = null;
    private loadNonce = 0;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createPolymarketPanelDom();
        this.bindEvents();
        this.bindState();
        this.render();
        this.initialized = true;
    }

    private bindEvents(): void {
        const dom = this.getDom();
        dom.polymarketEntryPriceCents.addEventListener("input", () => this.render());
        dom.polymarketScope.addEventListener("change", () => this.render());
    }

    private bindState(): void {
        state.subscribe("currentBacktestResult", (result) => {
            void this.handleBacktestResultChange(result);
        });

        state.subscribe("currentSymbol", () => {
            this.resetLoadedRows();
            this.render();
        });

        state.subscribe("currentInterval", () => {
            this.resetLoadedRows();
            this.render();
        });
    }

    private async handleBacktestResultChange(result: BacktestResult | null): Promise<void> {
        this.lastResult = result;
        this.loadError = null;

        if (!result || !isSupportedPolymarketBtc5mRun(state.currentSymbol, state.currentInterval) || result.trades.length === 0) {
            this.resetLoadedRows(false);
            this.render();
            return;
        }

        const targetTimes = result.trades
            .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
            .filter((value): value is number => value !== null);

        if (targetTimes.length === 0) {
            this.resetLoadedRows(false);
            this.render();
            return;
        }

        const requestId = ++this.loadNonce;
        this.isLoading = true;
        this.render();

        try {
            const rows = await loadBtc5mPolymarketOutcomesForTimeRange(
                Math.min(...targetTimes),
                Math.max(...targetTimes)
            );
            if (requestId !== this.loadNonce) {
                return;
            }

            this.outcomeByStartTs = new Map(rows.map((row) => [row.event_start_ts, row] as const));
            this.isLoading = false;
            this.render();
        } catch (error) {
            if (requestId !== this.loadNonce) {
                return;
            }

            this.outcomeByStartTs.clear();
            this.isLoading = false;
            this.loadError = error instanceof Error ? error.message : String(error);
            this.render();
        }
    }

    private render(): void {
        const dom = this.getDom();
        const result = this.lastResult;
        const supportedRun = isSupportedPolymarketBtc5mRun(state.currentSymbol, state.currentInterval);

        if (!result) {
            this.showEmpty("Run a backtest first, then this tab will estimate Polymarket fills for the executed trades.");
            return;
        }

        if (!supportedRun) {
            this.showEmpty("This tab currently supports BTCUSDT on the 5m chart only.");
            return;
        }

        if (result.trades.length === 0) {
            this.showEmpty("The current backtest has no executed trades to evaluate.");
            return;
        }

        if (this.isLoading) {
            this.showEmpty("Loading Polymarket outcome rows from local SQLite...");
            return;
        }

        if (this.loadError) {
            this.showEmpty(`Failed to load Polymarket outcomes. ${this.loadError}`);
            return;
        }

        const scope = this.readScope();
        const targetPriceCents = this.readEntryPriceCents();
        const analysis = analyzePolymarketFillability({
            trades: result.trades,
            outcomeByStartTs: this.outcomeByStartTs,
            targetPriceCents,
            scope,
        });

        const finalWindow = analysis.windows.at(-1);
        const filledByLastWindow = finalWindow?.filledTrades ?? 0;
        const filledWinRate = finalWindow?.filledWinRate ?? 0;
        const missingPriceByLastWindow = finalWindow?.missingPriceTrades ?? 0;

        dom.polymarketEligibleTrades.textContent = String(analysis.eligibleTrades);
        dom.polymarketFilledTrades.textContent = String(filledByLastWindow);
        dom.polymarketFillRate.textContent = this.formatPercent(finalWindow?.fillRate ?? 0);
        dom.polymarketFilledWinRate.textContent = this.formatPercent(filledWinRate);

        dom.polymarketStatus.textContent = [
            `${this.formatScopeLabel(scope)} at ${analysis.targetPriceCents.toFixed(1).replace(/\.0$/, "")}c.`,
            `${analysis.selectedTrades} selected trade${analysis.selectedTrades === 1 ? "" : "s"}, ${analysis.eligibleTrades} matched Polymarket row${analysis.eligibleTrades === 1 ? "" : "s"}.`,
            analysis.missingOutcomeTrades > 0 ? `${analysis.missingOutcomeTrades} trade${analysis.missingOutcomeTrades === 1 ? "" : "s"} missing outcome rows.` : "",
            missingPriceByLastWindow > 0 ? `${missingPriceByLastWindow} trade${missingPriceByLastWindow === 1 ? "" : "s"} missing sampled prices through +4m.` : "",
        ].filter(Boolean).join(" ");

        dom.polymarketTableBody.innerHTML = analysis.windows.map((window) => `
            <tr>
                <td>${window.label}</td>
                <td>${window.filledTrades}</td>
                <td>${this.formatPercent(window.fillRate)}</td>
                <td>${this.formatPercent(window.filledWinRate)}</td>
                <td>${window.missingPriceTrades}</td>
            </tr>
        `).join("");

        setVisible(dom.polymarketEmpty, false);
        setVisible(dom.polymarketContent, true);
    }

    private showEmpty(message: string): void {
        const dom = this.getDom();
        dom.polymarketSupport.textContent = message;
        setVisible(dom.polymarketEmpty, true);
        setVisible(dom.polymarketContent, false);
        dom.polymarketStatus.textContent = "";
        dom.polymarketTableBody.innerHTML = "";
        dom.polymarketEligibleTrades.textContent = "0";
        dom.polymarketFilledTrades.textContent = "0";
        dom.polymarketFillRate.textContent = "0.0%";
        dom.polymarketFilledWinRate.textContent = "0.0%";
    }

    private resetLoadedRows(clearResult = true): void {
        this.loadNonce++;
        this.outcomeByStartTs.clear();
        this.isLoading = false;
        this.loadError = null;
        if (clearResult) {
            this.lastResult = null;
        }
    }

    private readEntryPriceCents(): number {
        const raw = Number(this.getDom().polymarketEntryPriceCents.value);
        if (!Number.isFinite(raw)) {
            return 40;
        }
        return Math.max(0, Math.min(100, raw));
    }

    private readScope(): PolymarketFillScope {
        const value = this.getDom().polymarketScope.value;
        return value === "long" || value === "short" ? value : "all";
    }

    private formatScopeLabel(scope: PolymarketFillScope): string {
        if (scope === "long") return "YES-only fills";
        if (scope === "short") return "NO-only fills";
        return "All executed trades";
    }

    private formatPercent(value: number): string {
        return `${(value * 100).toFixed(1)}%`;
    }

    private getDom(): PolymarketPanelDom {
        return this.dom ??= createPolymarketPanelDom();
    }
}

export const polymarketPanelService = new PolymarketPanelService();
