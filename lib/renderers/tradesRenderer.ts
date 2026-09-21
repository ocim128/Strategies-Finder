import type { Time } from "lightweight-charts";
import type { OHLCVData, Trade } from "../strategies/index";
import { setVisible } from "../dom-utils";
import { state } from "../state";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { escapeHtml } from "../html-escape";
import { resolveOpenTradeDisplayMetrics } from "../open-trade-display";
import { createTradesRendererDom, type TradesRendererDom } from "./trades-renderer-dom";
import { copyToClipboard } from "../browser-transfer";
import { cancelIdleBatched, scheduleIdleBatched } from "../render-scheduler";
import { getCurrentUiBacktestEndpointSnapshot } from "../backtest-endpoint-copy";
import {
    buildBacktestDiagnosticOutput,
    type BacktestDiagnosticCountRow,
    type BacktestDiagnosticOutput,
} from "../backtest-diagnostic-output";
export class TradesRenderer {
    private static readonly MAX_TRADES = 250;
    private static readonly INITIAL_RENDER_BATCH_SIZE = 20;
    private static readonly DEFERRED_RENDER_BATCH_SIZE = 30;

    private dom: TradesRendererDom | null = null;
    private jumpToTrade: ((time: Time) => void) | null = null;
    private jumpHandlersBound = false;
    private diagnosticsHandlersBound = false;
    private tradeRenderGeneration = 0;
    private pendingDeferredRenderIds: Array<ReturnType<typeof scheduleIdleBatched>> = [];
    private latestBacktestDiagnostics: BacktestDiagnosticOutput | null = null;

    private getDom(): TradesRendererDom {
        return this.dom ??= createTradesRendererDom();
    }

    public async render(
        trades: Trade[],
        jumpToTrade: (time: Time) => void,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): Promise<boolean> {
        const container = this.getDom().tradesList;
        this.jumpToTrade = jumpToTrade;
        this.ensureTradeJumpHandlersBound();
        this.ensureBacktestDiagnosticsHandlersBound();
        this.cancelPendingDeferredRenders();
        const renderGeneration = ++this.tradeRenderGeneration;
        container.classList.remove('trades-list-parity');

if (trades.length === 0) {
            setVisible('emptyTrades', true);
            setVisible('tradesSummary', false);
            this.hideBacktestDiagnostics();
            container.innerHTML = '';
            return true;
        }

        setVisible('emptyTrades', false);
        setVisible('tradesSummary', true);
this.updateSummary(trades);
this.renderBacktestDiagnostics(trades);

this.renderTradeItemsProgressively(renderGeneration, container, trades, formatPrice, formatDate);
        return true;
    }

    private formatDuration(ms: number): string {
        if (ms < 0) return '-';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    private getExitReasonBadge(exitReason: Trade['exitReason']): string {
        if (!exitReason) return '';

        const reasonMap: Record<NonNullable<Trade['exitReason']>, { label: string; className: string; icon: string }> = {
            signal: { label: 'Signal', className: 'exit-reason-badge--signal', icon: 'SIG' },
            stop_loss: { label: 'SL', className: 'exit-reason-badge--stop-loss', icon: 'SL' },
            take_profit: { label: 'TP', className: 'exit-reason-badge--take-profit', icon: 'TP' },
            trailing_stop: { label: 'Trail', className: 'exit-reason-badge--trailing-stop', icon: 'TRL' },
            time_stop: { label: 'Time', className: 'exit-reason-badge--time-stop', icon: 'T' },
            partial: { label: 'Partial', className: 'exit-reason-badge--partial', icon: '1/2' },
            probation_fail: { label: 'Guard', className: 'exit-reason-badge--probation-fail', icon: 'GRD' },
            end_of_data: { label: 'EOD', className: 'exit-reason-badge--end-of-data', icon: 'EOD' },
            path_exit: { label: 'Path Exit', className: 'exit-reason-badge--path-exit', icon: 'PTH' },
        };

        const info = reasonMap[exitReason];
        if (!info) return '';

        return `<span class="exit-reason-badge ${info.className}" title="Exit: ${info.label}">${info.icon}</span>`;
    }

    private encodeTradeEntryTime(time: Time): string {
        return encodeURIComponent(JSON.stringify(time));
    }

    private renderTradeItemsProgressively(
        renderGeneration: number,
        container: HTMLElement,
        trades: Trade[],
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): void {
        const reversed = trades.slice().reverse();
        const toRender = reversed.slice(0, TradesRenderer.MAX_TRADES);
        const initialCount = Math.min(toRender.length, TradesRenderer.INITIAL_RENDER_BATCH_SIZE);
        container.innerHTML = this.renderTradeChunk(toRender, 0, initialCount, formatPrice, formatDate);

        let offset = initialCount;
        const appendLimitNotice = () => {
            if (renderGeneration !== this.tradeRenderGeneration || trades.length <= TradesRenderer.MAX_TRADES) {
                return;
            }

            const fragment = document.createRange().createContextualFragment(
                this.renderTradesLimitNotice(trades.length)
            );
            container.appendChild(fragment);
        };

        if (offset >= toRender.length) {
            appendLimitNotice();
            return;
        }

        const appendChunk = () => {
            if (renderGeneration !== this.tradeRenderGeneration) {
                return;
            }

            const nextOffset = Math.min(offset + TradesRenderer.DEFERRED_RENDER_BATCH_SIZE, toRender.length);
            const fragment = document.createRange().createContextualFragment(
                this.renderTradeChunk(toRender, offset, nextOffset, formatPrice, formatDate)
            );
            container.appendChild(fragment);
            offset = nextOffset;

            if (offset < toRender.length) {
                this.scheduleDeferredRender(appendChunk);
                return;
            }

            appendLimitNotice();
        };

        this.scheduleDeferredRender(appendChunk);
    }

    private renderTradeChunk(
        trades: Trade[],
        startIndex: number,
        endIndex: number,
        formatPrice: (p: number) => string,
        formatDate: (t: Time) => string
    ): string {
        let html = '';
        for (let index = startIndex; index < endIndex; index += 1) {
            html += this.renderTradeItem(trades[index], formatPrice, formatDate);
        }
        return html;
    }

    private renderTradesLimitNotice(totalTrades: number): string {
        return `<div class="trades-limit-notice" style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.9em; border-top: 1px solid var(--border-color);">Showing most recent ${TradesRenderer.MAX_TRADES} of ${totalTrades} trades</div>`;
    }

    private scheduleDeferredRender(callback: () => void): void {
        this.pendingDeferredRenderIds.push(scheduleIdleBatched(callback));
    }

    private cancelPendingDeferredRenders(): void {
        for (const deferredId of this.pendingDeferredRenderIds) {
            cancelIdleBatched(deferredId);
        }
        this.pendingDeferredRenderIds = [];
    }

    private renderTradeItem(trade: Trade, formatPrice: (p: number) => string, formatDate: (t: Time) => string): string {
        const display = this.getDisplayTradeMetrics(trade);
        const isProfit = display.pnl >= 0;
        const statusClass = isProfit ? 'win' : 'loss';
        const duration = this.formatDuration(display.durationMs);
        const fees = trade.fees ? `Fees: $${trade.fees.toFixed(2)}` : '';
        const entryValue = trade.size * trade.entryPrice;
        const sizeLabel = Number.isFinite(entryValue) && entryValue > 0
            ? `Entry Value: $${entryValue.toFixed(2)} | Qty: ${trade.size.toFixed(4)}`
            : `Qty: ${trade.size.toFixed(4)}`;
        const exitReasonBadge = this.getExitReasonBadge(display.displayExitReason);
        const sizeRow = `
                            <div class="trade-sub-info">
                                <span class="trade-size">${sizeLabel}</span>
                            </div>
            `;
        const entryDate = formatDate(trade.entryTime);

        let targetRow = '';
        if (display.displayExitReason === 'end_of_data') {
            const targets: string[] = [];
            if (trade.takeProfitPrice != null && trade.takeProfitPrice > 0) {
                const tpPct = Math.abs((trade.takeProfitPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target tp" title="Take Profit target">TP: ${formatPrice(trade.takeProfitPrice)} <span class="target-pct">(${tpPct.toFixed(2)}%)</span></span>`);
            }
            if (trade.stopLossPrice != null && trade.stopLossPrice > 0) {
                const slPct = Math.abs((trade.stopLossPrice - trade.entryPrice) / trade.entryPrice * 100);
                targets.push(`<span class="trade-target sl" title="Stop Loss target">SL: ${formatPrice(trade.stopLossPrice)} <span class="target-pct">(${slPct.toFixed(2)}%)</span></span>`);
            }
            if (targets.length > 0) {
                targetRow = `<div class="trade-targets-row">${targets.join('')}</div>`;
            }
        }

        return `
            <div class="trade-item ${statusClass}" data-entry-time="${this.encodeTradeEntryTime(trade.entryTime)}" role="button" tabindex="0">
                <div class="trade-main-row">
                    <div class="trade-left-group">
                        <div class="trade-icon ${trade.type === 'long' ? 'buy' : 'sell'}">
                            ${trade.type === 'long' ? 'B' : 'S'}
                        </div>
                        <div class="trade-price-info">
                            <div class="trade-price-flow">
                                <span class="price-val">${formatPrice(trade.entryPrice)}</span>
                                <span class="price-arrow">-></span>
                                <span class="price-val">${formatPrice(display.exitPrice)}</span>
                            </div>
                            <div class="trade-sub-info">
                                 <span class="trade-time">${entryDate}</span>
                                 <span class="separator">|</span>
                                 <span class="trade-duration">${duration}</span>
                                 ${exitReasonBadge}
                                 ${fees ? `<span class="separator">|</span><span class="trade-fees">${fees}</span>` : ''}
                             </div>
${sizeRow}
                        </div>
                    </div>
                    <div class="trade-result-group">
                        <div class="trade-pnl">
                            ${isProfit ? '+' : ''}$${display.pnl.toFixed(2)}
                        </div>
                        <div class="trade-pct">
                            ${Math.abs(display.pnlPercent).toFixed(2)}%
                        </div>
                    </div>
                </div>
                ${targetRow}
            </div>
        `;
    }

    private getDisplayTradeMetrics(trade: Trade): {
        exitPrice: number;
        pnl: number;
        pnlPercent: number;
        durationMs: number;
        displayExitReason: Trade['exitReason'];
    } {
        const liveCandle: OHLCVData | null = state.ohlcvData.length > 0
            ? state.ohlcvData[state.ohlcvData.length - 1]
            : null;

        return resolveOpenTradeDisplayMetrics(trade, liveCandle);
    }

    private ensureTradeJumpHandlersBound(): void {
        if (this.jumpHandlersBound) {
            return;
        }

        const container = this.getDom().tradesList;
        container.addEventListener('click', (event) => {
            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }
            this.activateTradeItem(item);
        });
        container.addEventListener('keydown', (event) => {
            if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
                return;
            }

            const item = this.resolveTradeItemTarget(event.target, container);
            if (!item) {
                return;
            }

            event.preventDefault();
            this.activateTradeItem(item);
        });
        this.jumpHandlersBound = true;
    }

    private ensureBacktestDiagnosticsHandlersBound(): void {
        if (this.diagnosticsHandlersBound) {
            return;
        }

        this.getDom().copyBacktestDiagnostics.addEventListener("click", () => {
            void this.copyBacktestDiagnostics();
        });
        this.diagnosticsHandlersBound = true;
    }

    private buildBacktestDiagnosticsForTrades(trades: Trade[]): BacktestDiagnosticOutput | null {
        const result = state.currentBacktestResult;
        if (!result) {
            return null;
        }

        return buildBacktestDiagnosticOutput({
            result: {
                ...result,
                trades,
                totalTrades: result.totalTrades > 0 ? result.totalTrades : trades.length,
            },
            snapshot: getCurrentUiBacktestEndpointSnapshot(),
            resultSource: state.currentBacktestResultSource,
        });
    }

    private renderBacktestDiagnostics(trades: Trade[]): void {
        const diagnostics = this.buildBacktestDiagnosticsForTrades(trades);
        const dom = this.getDom();
        this.latestBacktestDiagnostics = diagnostics;

        if (!diagnostics) {
            this.hideBacktestDiagnostics();
            return;
        }

        const chartExitSummary = this.formatDiagnosticCounts(diagnostics.chartExits.top, "none");
dom.backtestDiagnosticsSummary.textContent =
            `chart exits ${chartExitSummary}`;
        dom.backtestDiagnosticsWarnings.innerHTML = diagnostics.warnings
            .map((warning) => (
                `<div class="backtest-diagnostics__warning">${escapeHtml(warning.message)}</div>`
            ))
            .join("");
        setVisible(dom.backtestDiagnosticsWarnings, diagnostics.warnings.length > 0, "flex");

        dom.backtestDiagnosticsContent.innerHTML = [
this.renderDiagnosticMetric("Mode", diagnostics.run.executionModel ?? "n/a"),
            this.renderDiagnosticMetric("Chart Exits", chartExitSummary),
            this.renderDiagnosticMetric("Engine", this.formatEngineDiagnostic(diagnostics)),
        ].join("");
        dom.copyBacktestDiagnostics.disabled = false;
        setVisible(dom.backtestDiagnostics, true, "block");
    }

    private hideBacktestDiagnostics(): void {
        const dom = this.getDom();
        this.latestBacktestDiagnostics = null;
        dom.copyBacktestDiagnostics.disabled = true;
        dom.backtestDiagnosticsSummary.textContent = "No diagnostics yet.";
        dom.backtestDiagnosticsWarnings.innerHTML = "";
        dom.backtestDiagnosticsContent.innerHTML = "";
        setVisible(dom.backtestDiagnostics, false);
    }

    private formatDiagnosticCounts(rows: readonly BacktestDiagnosticCountRow[], emptyLabel: string): string {
        if (rows.length === 0) {
            return emptyLabel;
        }

        return rows
            .slice(0, 3)
            .map((row) => `${row.key} ${row.count}`)
            .join(" | ");
    }

    private formatEngineDiagnostic(diagnostics: BacktestDiagnosticOutput): string {
        const engine = diagnostics.run.engineUsed ?? "n/a";
        const counts = diagnostics.engineDiagnostics?.counts;
        if (!counts) {
            return engine;
        }

        return `${engine} | signals ${counts.inputSignals}->${counts.preparedSignals} | orders ${counts.signalExitOrders}`;
    }

    private renderDiagnosticMetric(label: string, value: string): string {
        return `
            <div class="backtest-diagnostics__metric">
                <div class="backtest-diagnostics__metric-label">${escapeHtml(label)}</div>
                <div class="backtest-diagnostics__metric-value">${escapeHtml(value)}</div>
            </div>
        `;
    }

    private async copyBacktestDiagnostics(): Promise<void> {
        if (!this.latestBacktestDiagnostics) {
            uiManager.showToast("No backtest diagnostics to copy", "info");
            return;
        }

        try {
            const copied = await copyToClipboard(JSON.stringify(this.latestBacktestDiagnostics, null, 2));
            if (!copied) {
                throw new Error("Clipboard copy returned false");
            }
            uiManager.showToast("Backtest diagnostics copied", "success");
        } catch (error) {
            debugLogger.error("trades.copy_backtest_diagnostics_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            uiManager.showToast("Copy failed - check browser permissions", "error");
        }
    }

    private resolveTradeItemTarget(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }

        const item = target.closest('.trade-item');
        if (!(item instanceof HTMLElement) || !container.contains(item)) {
            return null;
        }

        return item;
    }

    private activateTradeItem(item: HTMLElement): void {
        const encodedEntryTime = item.dataset.entryTime;
        if (!encodedEntryTime || !this.jumpToTrade) {
            return;
        }

        try {
            const entryTime = JSON.parse(decodeURIComponent(encodedEntryTime)) as Time;
            this.jumpToTrade(entryTime);
        } catch {
            // Ignore malformed attributes rather than breaking the trade list.
        }
    }

    private updateSummary(trades: Trade[]) {
        const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
        const winners = trades.filter(t => t.pnl > 0).length;
        const winRate = (winners / trades.length) * 100;
        const dom = this.getDom();

        dom.tradesTotalPnL.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`;
        dom.tradesTotalPnL.className = `summary-value ${totalPnL >= 0 ? 'positive' : 'negative'}`;
        dom.tradesWinRate.textContent = `${winRate.toFixed(1)}%`;
        dom.tradesWinRate.className = `summary-value ${winRate >= 50 ? 'positive' : 'negative'}`;
    }

    public clear() {
        this.cancelPendingDeferredRenders();
        this.tradeRenderGeneration += 1;
        setVisible('emptyTrades', true);
        setVisible('tradesSummary', false);
        this.hideBacktestDiagnostics();
        const container = this.getDom().tradesList;
        container.classList.remove('trades-list-parity');
        container.innerHTML = '';
    }
}

export const tradesRenderer = new TradesRenderer();
