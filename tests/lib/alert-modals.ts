import { getLatestActionableAlertSignal, parseAlertSignalPayload, resolveAlertSignalEntryPrice } from "./alert-signal-utils";
import { safeJsonParse } from "./alert-config-resolver";
import {
    getDefaultAlertMinClosedCandles,
    selectExecutionAwareClosedCandles,
} from "./alert-evaluation-window";
import { alertService, AlertSubscription } from "./alert-service";
import { backtestService } from "./backtest-service";
import { dataManager } from "./data-manager";
import { getOptionalElement } from "./dom-utils";
import { resolveEntryRiskTargets } from "./entry-risk-targets";
import { getLegacyCompatibleTradeFilterModeValue } from "./legacy-settings-compat";
import { createAccessibleModal, type AccessibleModalController } from "./modal-accessibility";
import { toFiniteNumber } from "./settings-parse-utils";
import { resolveTradeFilterMode } from "./settings-model";
import { BacktestSettings, OHLCVData, Time, Trade } from "./strategies/index";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { formatJakartaTime, isBusinessDayTime } from "./timezone-utils";

export interface AlertLastTradeModalOptions {
    getProviderCompatibilityError(symbol: string): string | null;
}

let alertConfigModalController: AccessibleModalController | null = null;
let lastTradeModalController: AccessibleModalController | null = null;

function formatValue(value: unknown): string {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NaN";
    if (typeof value === "boolean") return value ? "on" : "off";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.join(", ");
    if (value === null || value === undefined) return "-";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function appendModalSection(container: HTMLElement, title: string, lines: string[]): void {
    const section = document.createElement("section");
    section.className = "alert-config-section";

    const heading = document.createElement("h4");
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "alert-config-list";

    if (lines.length === 0) {
        const li = document.createElement("li");
        li.className = "alert-config-muted";
        li.textContent = "None";
        list.appendChild(li);
    } else {
        lines.forEach((line) => {
            const li = document.createElement("li");
            li.textContent = line;
            list.appendChild(li);
        });
    }

    section.appendChild(list);
    container.appendChild(section);
}



function openLastTradeModal(title: string): void {
    const overlay = getOptionalElement<HTMLElement>("lastTradeModal");
    const titleEl = getOptionalElement<HTMLElement>("lastTradeModalTitle");
    if (!overlay || !titleEl) return;

    titleEl.textContent = title;

    const loadingEl = getOptionalElement<HTMLElement>("lastTradeLoading");
    const contentEl = getOptionalElement<HTMLElement>("lastTradeContent");
    const errorEl = getOptionalElement<HTMLElement>("lastTradeError");

    if (loadingEl) loadingEl.style.display = "";
    if (contentEl) contentEl.style.display = "none";
    if (errorEl) errorEl.style.display = "none";

    lastTradeModalController?.open();
}

function showLastTradeError(message: string): void {
    const loadingEl = getOptionalElement<HTMLElement>("lastTradeLoading");
    const contentEl = getOptionalElement<HTMLElement>("lastTradeContent");
    const errorEl = getOptionalElement<HTMLElement>("lastTradeError");
    const errorMsgEl = errorEl?.querySelector(".error-message");

    if (loadingEl) loadingEl.style.display = "none";
    if (contentEl) contentEl.style.display = "none";
    if (errorEl) errorEl.style.display = "";
    if (errorMsgEl) errorMsgEl.textContent = message;
}

function toEpochMs(value: unknown): number | null {
    const unixSeconds = parseTimeToUnixSeconds(value);
    return unixSeconds === null ? null : unixSeconds * 1000;
}

function isBusinessDayValue(value: unknown): value is Time {
    if (typeof value === "object" && value !== null && "year" in value) {
        return true;
    }
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatTimeForDisplay(time: unknown): string {
    if (time == null) return "N/A";
    const unixSeconds = parseTimeToUnixSeconds(time);
    if (unixSeconds === null) return "N/A";
    const displayTime: Time = isBusinessDayValue(time) ? time : (unixSeconds as Time);

    if (isBusinessDayTime(displayTime)) {
        return formatJakartaTime(displayTime, {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    }

    return formatJakartaTime(displayTime, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

function formatDurationForTradeTimes(entryTime: unknown, exitTime: unknown): string {
    if (entryTime == null || exitTime == null) return "-";
    const entryMs = toEpochMs(entryTime);
    const exitMs = toEpochMs(exitTime);
    if (entryMs === null || exitMs === null) return "-";
    return formatDuration(exitMs - entryMs);
}

function selectLastTradeForDisplay(trades: Trade[]): { trade: Trade | null; tradeNumber: number; openTrade: Trade | null } {
    if (trades.length === 0) {
        return { trade: null, tradeNumber: 0, openTrade: null };
    }

    const latestTrade = trades[trades.length - 1];
    if (latestTrade.exitReason !== "end_of_data") {
        return { trade: latestTrade, tradeNumber: trades.length, openTrade: null };
    }

    for (let i = trades.length - 1; i >= 0; i--) {
        if (trades[i].exitReason !== "end_of_data") {
            return { trade: trades[i], tradeNumber: i + 1, openTrade: latestTrade };
        }
    }

    return { trade: latestTrade, tradeNumber: trades.length, openTrade: latestTrade };
}

function createOpenTradeFromSignalRecord(
    signal: { id: number; direction: "long" | "short"; signal_time: number; signal_price: number; payload_json?: string | null },
    backtestSettings: BacktestSettings = {},
    candles: OHLCVData[] = []
): Trade | null {
    if (!signal || !Number.isFinite(signal.signal_time)) {
        return null;
    }

    const payload = parseAlertSignalPayload(signal);
    const entryPrice = resolveAlertSignalEntryPrice(signal, backtestSettings);
    if (entryPrice === null) {
        return null;
    }

    const riskTargets = resolveEntryRiskTargets({
        candles,
        entryTime: signal.signal_time as Time,
        entryPrice,
        direction: signal.direction,
        settings: backtestSettings,
    });
    let takeProfitPrice: number | null = riskTargets.takeProfitPrice;
    let stopLossPrice: number | null = riskTargets.stopLossPrice;

    if (takeProfitPrice === null) {
        const tpValue = Number(payload.takeProfitPrice);
        takeProfitPrice = Number.isFinite(tpValue) ? tpValue : null;
    }
    if (stopLossPrice === null) {
        const slValue = Number(payload.stopLossPrice);
        stopLossPrice = Number.isFinite(slValue) ? slValue : null;
    }

    return {
        id: Number.isFinite(signal.id) ? signal.id : 0,
        type: signal.direction === "short" ? "short" : "long",
        entryTime: signal.signal_time as Time,
        entryPrice,
        exitTime: signal.signal_time as Time,
        exitPrice: entryPrice,
        pnl: 0,
        pnlPercent: 0,
        size: 0,
        fees: 0,
        exitReason: "end_of_data",
        stopLossPrice,
        takeProfitPrice,
    };
}

function getExitReasonBadge(exitReason: string | null | undefined): string {
    if (!exitReason) return "-";

    const reasonMap: Record<string, { label: string; color: string }> = {
        signal: { label: "Signal", color: "#3b82f6" },
        stop_loss: { label: "Stop Loss", color: "#ef4444" },
        take_profit: { label: "Take Profit", color: "#22c55e" },
        trailing_stop: { label: "Trailing Stop", color: "#f59e0b" },
        time_stop: { label: "Time Stop", color: "#8b5cf6" },
        partial: { label: "Partial", color: "#06b6d4" },
        probation_fail: { label: "Weak-Start Guard", color: "#ec4899" },
        end_of_data: { label: "End of Data", color: "#f97316" },
    };

    const info = reasonMap[exitReason];
    if (!info) return exitReason;

    return `<span style="background: ${info.color}20; color: ${info.color}; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${info.label}</span>`;
}

function formatDuration(ms: number): string {
    if (ms < 0) return "-";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function showLastTradeResult(
    trade: Trade | null,
    symbol: string,
    interval: string,
    totalTrades: number,
    tradeNumber: number,
    openTrade: Trade | null
): void {
    const loadingEl = getOptionalElement<HTMLElement>("lastTradeLoading");
    const contentEl = getOptionalElement<HTMLElement>("lastTradeContent");
    const errorEl = getOptionalElement<HTMLElement>("lastTradeError");
    const summaryEl = getOptionalElement<HTMLElement>("lastTradeSummary");
    const detailsEl = getOptionalElement<HTMLElement>("lastTradeDetails");

    if (loadingEl) loadingEl.style.display = "none";
    if (errorEl) errorEl.style.display = "none";
    if (contentEl) contentEl.style.display = "";

    if (!trade) {
        if (summaryEl) summaryEl.innerHTML = '<p class="no-trades">No trades found in backtest results.</p>';
        if (detailsEl) detailsEl.innerHTML = "";
        return;
    }

    const isLong = trade.type === "long";
    const isOpenTrade = trade.exitReason === "end_of_data";
    const isWin = trade.pnl >= 0;
    const entryTimeStr = formatTimeForDisplay(trade.entryTime);
    const exitTimeStr = isOpenTrade ? "Still open" : (trade.exitTime ? formatTimeForDisplay(trade.exitTime) : "N/A");
    const duration = !isOpenTrade && trade.entryTime && trade.exitTime
        ? formatDurationForTradeTimes(trade.entryTime, trade.exitTime)
        : "Open";

    const exitReasonBadge = isOpenTrade
        ? '<span style="background: #22c55e20; color: #22c55e; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">Open Position</span>'
        : getExitReasonBadge(trade.exitReason);
    const openTradeNote = openTrade
        ? `<div class="detail-row divider"></div>
           <div class="detail-row"><span class="label">Live Position</span><span class="value">Open ${openTrade.type.toUpperCase()} from ${formatTimeForDisplay(openTrade.entryTime)} (${openTrade.entryPrice.toFixed(2)})</span></div>`
        : "";

    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="last-trade-header ${isWin ? "win" : "loss"}">
                <span class="trade-type ${isLong ? "long" : "short"}">${isLong ? "LONG" : "SHORT"}</span>
                <span class="trade-result ${isWin ? "win" : "loss"}">${isWin ? "+" : ""}${trade.pnl.toFixed(2)} (${trade.pnlPercent >= 0 ? "+" : ""}${trade.pnlPercent.toFixed(2)}%)</span>
            </div>
            ${openTrade ? '<p class="no-trades" style="margin-top:8px;">Latest position is still open. Telegram alert is sent once per entry when the stream has no matching previous signal.</p>' : ""}
        `;
    }

    if (detailsEl) {
        let targetsHtml = "";
        if (trade.takeProfitPrice != null && trade.takeProfitPrice > 0) {
            const tpPct = Math.abs((trade.takeProfitPrice - trade.entryPrice) / trade.entryPrice * 100);
            targetsHtml += `<div class="detail-row"><span class="label">TP Price</span><span class="value">${trade.takeProfitPrice.toFixed(2)} (${tpPct.toFixed(2)}%)</span></div>`;
        }
        if (trade.stopLossPrice != null && trade.stopLossPrice > 0) {
            const slPct = Math.abs((trade.stopLossPrice - trade.entryPrice) / trade.entryPrice * 100);
            targetsHtml += `<div class="detail-row"><span class="label">SL Price</span><span class="value">${trade.stopLossPrice.toFixed(2)} (${slPct.toFixed(2)}%)</span></div>`;
        }

        detailsEl.innerHTML = `
            <div class="detail-grid">
                <div class="detail-row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
                <div class="detail-row"><span class="label">Interval</span><span class="value">${interval}</span></div>
                <div class="detail-row"><span class="label">Trade #</span><span class="value">${tradeNumber} of ${totalTrades}</span></div>
                <div class="detail-row divider"></div>
                <div class="detail-row"><span class="label">Entry Price</span><span class="value">${trade.entryPrice.toFixed(2)}</span></div>
                <div class="detail-row"><span class="label">Entry Time</span><span class="value">${entryTimeStr}</span></div>
                <div class="detail-row"><span class="label">${isOpenTrade ? "Mark Price" : "Exit Price"}</span><span class="value">${trade.exitPrice?.toFixed(2) ?? "N/A"}</span></div>
                <div class="detail-row"><span class="label">Exit Time</span><span class="value">${exitTimeStr}</span></div>
                <div class="detail-row"><span class="label">Duration</span><span class="value">${duration}</span></div>
                <div class="detail-row"><span class="label">Exit Reason</span><span class="value">${exitReasonBadge}</span></div>
                ${trade.fees ? `<div class="detail-row"><span class="label">Fees</span><span class="value">${trade.fees.toFixed(2)}</span></div>` : ""}
                ${targetsHtml ? `<div class="detail-row divider"></div>${targetsHtml}` : ""}
                ${openTradeNote}
            </div>
        `;
    }
}

export function initAlertModals(): void {
    alertConfigModalController = createAccessibleModal({
        overlayId: "alertConfigModal",
        titleId: "alertConfigModalTitle",
        initialFocusSelector: "#alertConfigModalClose",
    });
    lastTradeModalController = createAccessibleModal({
        overlayId: "lastTradeModal",
        titleId: "lastTradeModalTitle",
        initialFocusSelector: "#lastTradeModalClose",
    });
}

export function closeAlertConfigModal(): void {
    alertConfigModalController?.close();
}

export function closeLastTradeModal(): void {
    lastTradeModalController?.close();
}

export function openSubscriptionInfoModal(
    sub: AlertSubscription,
    configName: string | null
): void {
    const overlay = getOptionalElement<HTMLElement>("alertConfigModal");
    const titleEl = getOptionalElement<HTMLElement>("alertConfigModalTitle");
    const bodyEl = getOptionalElement<HTMLElement>("alertConfigModalBody");
    if (!overlay || !titleEl || !bodyEl) return;

    const settings = safeJsonParse<Record<string, unknown>>(sub.backtest_settings_json, {});
    const strategyParams = safeJsonParse<Record<string, unknown>>(sub.strategy_params_json, {});

    titleEl.textContent = `Alert Config: ${sub.symbol} ${sub.interval}`;
    bodyEl.innerHTML = "";
    bodyEl.className = "modal-body alert-config-modal-body";

    appendModalSection(bodyEl, "Identity", [
        `Configuration Name: ${configName ?? "(unresolved - using strategy key)"}`,
        `Strategy Key: ${sub.strategy_key}`,
        `Stream ID: ${sub.stream_id}`,
        `Freshness Bars: ${sub.freshness_bars}`,
        `Notifications: Telegram ${sub.notify_telegram === 1 ? "on" : "off"}, Exit ${sub.notify_exit === 1 ? "on" : "off"}`,
    ]);

    appendModalSection(bodyEl, "Risk / Targets", [
        `Risk Mode: ${formatValue(settings.riskMode)}`,
        `Take Profit: ${settings.takeProfitEnabled === true ? `on (${formatValue(settings.takeProfitPercent)}%)` : "off"}`,
        `Stop Loss: ${settings.stopLossEnabled === true ? `on (${formatValue(settings.stopLossPercent)}%)` : "off"}`,
        `Win-Streak SL Override: ${(settings.riskWinStreakStopLossEnabled === true || settings.riskWinStreakStopLossToggle === true)
            && toFiniteNumber(settings.riskWinStreakStopLossAfterWins)
            && toFiniteNumber(settings.riskWinStreakStopLossPercent)
            ? `after ${formatValue(settings.riskWinStreakStopLossAfterWins)} wins => ${formatValue(settings.riskWinStreakStopLossPercent)}%`
            : "off"}`,
        `ATR Period: ${formatValue(settings.atrPeriod)}`,
        `Stop Loss ATR: ${formatValue(settings.stopLossAtr)}`,
        `Take Profit ATR: ${formatValue(settings.takeProfitAtr)}`,
        `Trailing ATR: ${formatValue(settings.trailingAtr)}`,
    ]);

    appendModalSection(bodyEl, "Trade Filter", [
        `Filter Enabled: ${settings.tradeFilterSettingsToggle === true ? "on" : "off"}`,
        `Filter Mode: ${formatValue(resolveTradeFilterMode({ tradeFilterMode: getLegacyCompatibleTradeFilterModeValue(settings) as any }))}`,
        `Execution EMA Period: ${formatValue(settings.executionTrendEmaPeriod)}`,
        `Confirm Lookback: ${formatValue(settings.confirmLookback)}`,
        `Volume SMA Period: ${formatValue(settings.volumeSmaPeriod)}`,
        `Volume Multiplier: ${formatValue(settings.volumeMultiplier)}`,
        `RSI Period: ${formatValue(settings.confirmRsiPeriod)}`,
        `RSI Bullish: ${formatValue(settings.confirmRsiBullish)}`,
        `RSI Bearish: ${formatValue(settings.confirmRsiBearish)}`,
    ]);

    appendModalSection(bodyEl, "Execution", [
        `Trade Direction: ${formatValue(settings.tradeDirection)}`,
        `Invert Signals: ${formatValue(settings.invertSignals)}`,
        `Execution Model: ${formatValue(settings.executionModel)}`,
        `Allow Same Bar Exit: ${formatValue(settings.allowSameBarExit)}`,
        `Slippage Bps: ${formatValue(settings.slippageBps)}`,
        `Strategy Timeframe Enabled: ${formatValue(settings.strategyTimeframeEnabled)}`,
        `Strategy Timeframe Minutes: ${formatValue(settings.strategyTimeframeMinutes)}`,
    ]);

    const paramsLines = Object.keys(strategyParams)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key}: ${formatValue(strategyParams[key])}`);
    appendModalSection(bodyEl, "Strategy Params", paramsLines);

    alertConfigModalController?.open();
}

export async function handleLastTradeAction(
    streamId: string,
    sub: AlertSubscription,
    options: AlertLastTradeModalOptions
): Promise<void> {
    openLastTradeModal(`Last Trade: ${sub.symbol} ${sub.interval}`);

    try {
        const providerError = options.getProviderCompatibilityError(sub.symbol);
        if (providerError) {
            showLastTradeError(providerError);
            return;
        }

        const strategyParams = safeJsonParse<Record<string, number>>(sub.strategy_params_json, {});
        const backtestSettings = safeJsonParse<BacktestSettings>(sub.backtest_settings_json, {});
        const effectiveBacktestSettings = backtestSettings;
        const subscriptionCandleLimit = Number.isFinite(sub.candle_limit) && sub.candle_limit > 0
            ? Math.floor(sub.candle_limit)
            : null;

        const ohlcvData = subscriptionCandleLimit !== null
            ? await dataManager.fetchDataWithLimit(sub.symbol, sub.interval, subscriptionCandleLimit)
            : await dataManager.fetchData(sub.symbol, sub.interval);

        if (ohlcvData.length === 0) {
            throw new Error(`No data available for ${sub.symbol} ${sub.interval}`);
        }

        const evaluationCandles = selectExecutionAwareClosedCandles(
            ohlcvData,
            sub.interval,
            effectiveBacktestSettings,
            {
                nowSec: Math.floor(Date.now() / 1000),
                minClosedCandles: getDefaultAlertMinClosedCandles(),
            }
        );
        if (!evaluationCandles) {
            throw new Error(`Not enough closed candles available for ${sub.symbol} ${sub.interval}`);
        }

        const result = await backtestService.runBacktestForSubscription(
            evaluationCandles,
            sub.interval,
            sub.strategy_key,
            strategyParams,
            effectiveBacktestSettings
        );

        const tradeSelection = selectLastTradeForDisplay(result.trades);
        if (!tradeSelection.trade) {
            const history = await alertService.getSignalHistory(streamId, 10);
            const latestActionableSignal = getLatestActionableAlertSignal(history);
            const fallbackTrade = latestActionableSignal
                ? createOpenTradeFromSignalRecord(latestActionableSignal, effectiveBacktestSettings, evaluationCandles)
                : null;
            if (fallbackTrade) {
                showLastTradeResult(fallbackTrade, sub.symbol, sub.interval, 1, 1, fallbackTrade);
                return;
            }
        }

        showLastTradeResult(
            tradeSelection.trade,
            sub.symbol,
            sub.interval,
            result.trades.length,
            tradeSelection.tradeNumber,
            tradeSelection.openTrade
        );
    } catch (err) {
        showLastTradeError("Failed to run backtest: " + (err instanceof Error ? err.message : String(err)));
    }
}
