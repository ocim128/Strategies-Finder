/**
 * Batch Backtest UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/hunt/hunt-service.ts`). Binds the tab's buttons, reads the CURRENT
 * strategy / params / backtest / capital settings once per run, and replays
 * them across every pair in the user's list through the pure runner.
 *
 * Visual output mirrors Finder's universe symbol rows (same verdict labels
 * and metric order) so a Batch run reads the same as a Finder universe run.
 */

import { ensureBuiltInStrategyLoaded } from "../strategies/built-in-catalog";
import { backtestService } from "../backtest-service";
import { paramManager } from "../param-manager";
import { state } from "../state";
import { strategyRegistry } from "../../strategyRegistry";
import { formatProfitFactor } from "../ui-formatters";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import type { BacktestResult, Time } from "../types/strategies";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import { loadBatchDataset } from "./batch-backtest-loader";
import {
    parseBatchSymbols,
    runBatchBacktest,
    type BatchBacktestSymbolResult,
} from "./batch-backtest-runner";

class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: BatchBacktestSymbolResult[] = [];
    // Monotonic run token. A stale run that resumes after a newer run started
    // (e.g. Stop -> Run while the old run is still awaiting executeBacktest)
    // sees its token as stale and stops writing DOM/state, preventing two
    // concurrent runs from racing on `this.lastResults` and the results list.
    private runToken = 0;

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
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

    private bindEvents(dom: BatchBacktestDom): void {
        dom.batchBacktestRunBtn.addEventListener("click", () => {
            void this.runBatch();
        });
        dom.batchBacktestStopBtn.addEventListener("click", () => {
            this.cancelled = true;
        });
        dom.batchBacktestCopyBtn.addEventListener("click", () => {
            void this.copyResults();
        });
        dom.batchBacktestUseCurrent.addEventListener("click", () => {
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value.trim();
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value
                    ? `${dom.batchBacktestSymbols.value}\n${current}`
                    : current;
            }
            this.updateSummary(dom);
        });
        dom.batchBacktestClear.addEventListener("click", () => {
            dom.batchBacktestSymbols.value = "";
            this.updateSummary(dom);
        });
        dom.batchBacktestSymbols.addEventListener("input", () => {
            this.updateSummary(dom);
        });
    }

    private async runBatch(): Promise<void> {
        const dom = this.getDom();
        const symbols = parseBatchSymbols(dom.batchBacktestSymbols.value);
        if (symbols.length === 0) {
            dom.batchBacktestStatus.textContent = "Add at least one pair.";
            return;
        }

        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            dom.batchBacktestStatus.textContent = `Strategy not loaded: ${strategyKey}`;
            return;
        }

        // Read the CURRENT settings once. This is the core contract: Batch
        // replays whatever the user has tuned in the UI right now.
        const strategyParams = paramManager.getValues(strategy);
        const backtestSettings = backtestService.getBacktestSettings();
        const capitalSettings = backtestService.getCapitalSettings();
        const interval = state.currentInterval;

        // Invalidate any in-flight run and claim this one. The stale run will
        // see its token mismatch after its next await and stop mutating state.
        this.runToken += 1;
        const token = this.runToken;
        this.cancelled = false;
        this.lastResults = [];
        dom.batchBacktestRunBtn.disabled = true;
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestCopyBtn.disabled = true;
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        try {
            const output = await runBatchBacktest(
                {
                    interval,
                    strategyKey,
                    strategy,
                    strategyParams,
                    backtestSettings,
                    capitalSettings,
                    symbols,
                    loadDataset: (sym, intv, signal) => loadBatchDataset(sym, intv, signal),
                },
                {
                    setProgress: (percent, text) => {
                        if (token !== this.runToken) return;
                        this.setProgress(dom, percent, text);
                    },
                    setStatus: (text) => {
                        if (token !== this.runToken) return;
                        dom.batchBacktestStatus.textContent = text;
                    },
                    onSymbolComplete: (_index, result) => {
                        if (token !== this.runToken) return;
                        this.lastResults.push(result);
                        this.appendResultRow(dom, result);
                    },
                    isCancelled: () => token !== this.runToken || this.cancelled,
                },
            );
            // A newer run has taken over; leave all UI state to that run.
            if (token !== this.runToken) return;
            this.lastResults = output.results;
            // Re-render in stable input order so failed/slow loads don't jumble.
            this.renderAllResults(dom, this.lastResults);
            dom.batchBacktestStatus.textContent = this.cancelled
                ? `Stopped (${output.results.length}/${symbols.length} pairs)`
                : `Done (${output.results.length} pairs, ${output.failedSymbols.length} failed)`;
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.batchBacktestStatus.textContent = `Error: ${message}`;
            debugLogger.error("batch_backtest.run_failed", { error: message });
        } finally {
            // Only restore buttons if this run is still the active one.
            if (token === this.runToken) {
                dom.batchBacktestRunBtn.disabled = false;
                setVisible(dom.batchBacktestStopBtn, false);
                dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
            }
        }
    }

    private async copyResults(): Promise<void> {
        if (this.lastResults.length === 0) return;
        const text = this.lastResults.map((r) => formatResultRowPipe(r)).join("\n");
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard can fail in non-secure contexts; fall back silently.
        }
    }

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    private appendResultRow(dom: BatchBacktestDom, result: BatchBacktestSymbolResult): void {
        dom.batchBacktestResults.appendChild(this.createResultRow(result));
    }

    private renderAllResults(dom: BatchBacktestDom, results: BatchBacktestSymbolResult[]): void {
        const fragment = document.createDocumentFragment();
        for (const result of results) {
            fragment.appendChild(this.createResultRow(result));
        }
        dom.batchBacktestResults.replaceChildren(fragment);
        setVisible(dom.batchBacktestEmpty, results.length === 0);
    }

    private createResultRow(result: BatchBacktestSymbolResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";

        const verdict = computePerformanceVerdict(result.result, result.status);
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${verdict.cssClass}`;
        badge.textContent = verdict.label;
        line.appendChild(badge);

        line.appendChild(document.createTextNode(` ${formatResultRowPipe(result)}`));
        return line;
    }

    // --------------------------------------------------------------------
    // Progress / summary helpers
    // --------------------------------------------------------------------

    private setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        dom.batchBacktestProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.batchBacktestProgressText.textContent = text;
    }

    private resetProgress(dom: BatchBacktestDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.batchBacktestStatus.textContent = "Idle";
    }

    private updateSummary(dom: BatchBacktestDom): void {
        const count = parseBatchSymbols(dom.batchBacktestSymbols.value).length;
        dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
    }
}

/**
 * Format one result row as pipe-delimited text, mirroring the Symbol Universe
 * symbol-breakdown line the user is already used to reading.
 */
function formatResultRowPipe(result: BatchBacktestSymbolResult): string {
    const parts: string[] = [result.symbol, formatStatus(result.status)];
    parts.push(`Bars ${result.barCount}`);
    if (result.result) {
        const r: BacktestResult = result.result;
        parts.push(`Net ${formatCurrency(r.netProfit)}`);
        parts.push(`Exp ${r.expectancy.toFixed(2)}`);
        parts.push(`PF ${formatProfitFactor(r.profitFactor)}`);
        parts.push(`WR ${r.winRate.toFixed(0)}%`);
        parts.push(`Sharpe ${Number.isFinite(r.sharpeRatio) ? r.sharpeRatio.toFixed(2) : "--"}`);
        parts.push(
            Number.isFinite(r.maxDrawdownPercent)
                ? `DD ${r.maxDrawdownPercent.toFixed(2)}%`
                : "DD --",
        );
        parts.push(`Trades ${r.totalTrades}`);
    }
    if (result.error) parts.push(result.error);
    const range = formatTimeRange(result.firstTime, result.lastTime);
    if (range) parts.push(range);
    return parts.join(" | ");
}

function formatStatus(status: BatchBacktestSymbolResult["status"]): string {
    switch (status) {
        case "profitable": return "Profitable";
        case "losing": return "Losing";
        case "flat": return "Flat";
        case "no_trades": return "No Trades";
        case "load_failed": return "Load Failed";
        case "run_failed": return "Run Failed";
        default: return status;
    }
}

function formatCurrency(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}$${value.toFixed(2)}`;
}

function formatTimeRange(firstTime?: Time, lastTime?: Time): string {
    if (!firstTime && !lastTime) return "";
    const firstLabel = firstTime ? formatTime(firstTime) : "?";
    const lastLabel = lastTime ? formatTime(lastTime) : "?";
    return `${firstLabel} -> ${lastLabel}`;
}

function formatTime(time: Time): string {
    if (typeof time === "string") return time;
    if (typeof time === "number") {
        const ms = time > 1_000_000_000_000 ? time : time * 1000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
        const month = String(time.month).padStart(2, "0");
        const day = String(time.day).padStart(2, "0");
        return `${time.year}-${month}-${day}`;
    }
    return String(time);
}

export const batchBacktestService = new BatchBacktestService();
