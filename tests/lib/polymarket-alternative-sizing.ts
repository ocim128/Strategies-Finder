import type { Time } from "lightweight-charts";
import type { BacktestResult, BacktestSettings, OHLCVData, Trade } from "./types/strategies";
import type { CapitalSettings, TradeSizingMode } from "./types/backtest";
import {
    resolveAllocatedCapital,
    type SmartSizingState,
} from "./strategies/backtest/position-builder";
import { calculateMaxDrawdown } from "./strategies/backtest/position-stats";
import { timeKey } from "./strategies/backtest/backtest-utils";
import { createKellySizingState, updateKellyState } from "./strategies/sizing/kelly-criterion";
import { createMartingaleState, updateMartingaleState } from "./strategies/sizing/martingale";
import { createOptimalFState, updateOptimalFState } from "./strategies/sizing/optimal-f";
import { resolvePolymarketTradePayout } from "./polymarket-payout";
import { calculateATR } from "./strategies/indicators";
import { getCloses, getHighs, getLows } from "./strategies/strategy-helpers";

export interface PolymarketAlternativeSizingInput {
    result: BacktestResult;
    chartData: OHLCVData[];
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    alternativeSizingEnabled: boolean;
}

const VELOCITY_SCORE_HISTORY_LIMIT = 12;
const POLYMARKET_BASE_TRADE_AMOUNT = 1;

function shouldApplyPolymarketAlternativeSizing(
    capitalSettings: CapitalSettings,
    alternativeSizingEnabled: boolean
): boolean {
    return alternativeSizingEnabled
        && capitalSettings.sizingMode !== "fixed"
        && capitalSettings.sizingMode !== "percent";
}

function createPolymarketSizingState(): SmartSizingState {
    return {
        recentVelocityScores: [],
        kellyState: createKellySizingState(),
        martingaleState: createMartingaleState(),
        optimalFState: createOptimalFState(),
    };
}

function pushPolymarketVelocityScore(state: SmartSizingState, pnl: number): void {
    const score = pnl > 0 ? 1 : pnl < 0 ? -0.75 : 0;
    state.recentVelocityScores.push(score);
    if (state.recentVelocityScores.length > VELOCITY_SCORE_HISTORY_LIMIT) {
        state.recentVelocityScores.shift();
    }
}

function updatePolymarketSizingState(
    state: SmartSizingState,
    sizingMode: TradeSizingMode,
    pnl: number,
    kellyUnitPnl: number,
    advancedSizing: CapitalSettings["advancedSizing"]
): void {
    if (sizingMode === "smart_fixed_velocity_memory" || sizingMode === "smart_fixed_quality_x_velocity") {
        pushPolymarketVelocityScore(state, pnl);
        return;
    }
    if (sizingMode === "kelly_criterion") {
        const kellyPnl = Number.isFinite(kellyUnitPnl) ? kellyUnitPnl : pnl;
        updateKellyState(state.kellyState ?? createKellySizingState(), { pnl: kellyPnl, isWin: kellyPnl > 0 });
        return;
    }
    if (sizingMode === "martingale" || sizingMode === "anti_martingale") {
        updateMartingaleState(
            state.martingaleState ?? createMartingaleState(),
            { pnl, isWin: pnl > 0 },
            advancedSizing,
            sizingMode === "anti_martingale"
        );
        return;
    }
    if (sizingMode === "optimal_f" || sizingMode === "secure_f") {
        updateOptimalFState(state.optimalFState ?? createOptimalFState(), pnl, advancedSizing);
    }
}

function buildTimeIndex(data: readonly OHLCVData[]): Map<string, number> {
    const index = new Map<string, number>();
    for (let i = 0; i < data.length; i += 1) {
        const candle = data[i];
        if (!candle) continue;
        const key = timeKey(candle.time);
        if (!index.has(key)) {
            index.set(key, i);
        }
    }
    return index;
}

function getTradeEntryBarIndex(trade: Trade, timeIndex: ReadonlyMap<string, number>): number | null {
    const index = timeIndex.get(timeKey(trade.entryTime));
    return typeof index === "number" ? index : null;
}

function getEquityCheckpointTime(trade: Trade): Time {
    const outcomeExitTs = trade.polymarketOutcome?.marketExitTs;
    return typeof outcomeExitTs === "number" && Number.isFinite(outcomeExitTs)
        ? outcomeExitTs as Time
        : trade.exitTime;
}

function getProfitFactor(grossProfit: number, grossLoss: number): number {
    if (grossProfit <= 0) {
        return 0;
    }
    return grossLoss > 0 ? grossProfit / grossLoss : Infinity;
}

function sizingModeNeedsChartBar(sizingMode: TradeSizingMode): boolean {
    return sizingMode === "smart_fixed_quality_x_velocity"
        || sizingMode === "volatility_targeting"
        || sizingMode === "risk_parity";
}

function sizingModeNeedsAtr(sizingMode: TradeSizingMode): boolean {
    return sizingMode === "smart_fixed_quality_x_velocity";
}

function computeAtrForSizing(
    chartData: OHLCVData[],
    backtestSettings: BacktestSettings,
    sizingMode: TradeSizingMode
): Array<number | null> {
    if (!sizingModeNeedsAtr(sizingMode)) {
        return [];
    }

    const period = Number.isFinite(backtestSettings.atrPeriod)
        ? Math.max(1, Math.round(backtestSettings.atrPeriod as number))
        : 14;
    return calculateATR(
        getHighs(chartData),
        getLows(chartData),
        getCloses(chartData),
        period
    );
}

export function applyPolymarketAlternativeSizing(input: PolymarketAlternativeSizingInput): BacktestResult {
    const { result, chartData, backtestSettings, capitalSettings, alternativeSizingEnabled } = input;
    if (!shouldApplyPolymarketAlternativeSizing(capitalSettings, alternativeSizingEnabled)) {
        return result;
    }

    if (!result.trades.some((trade) => trade.polymarketOutcome)) {
        return result;
    }

    const sizingMode = capitalSettings.sizingMode;
    const needsChartBar = sizingModeNeedsChartBar(sizingMode);
    const timeIndex = needsChartBar ? buildTimeIndex(chartData) : null;
    const atr = computeAtrForSizing(chartData, backtestSettings, sizingMode);
    const sizingState = createPolymarketSizingState();
    const advancedSizing = capitalSettings.advancedSizing;
    const executionModel = backtestSettings.executionModel ?? "signal_close";

    let equity = capitalSettings.initialCapital;
    let sizedTrades = 0;
    let sizedSkippedTrades = 0;
    let sizedNoCapitalTrades = 0;
    let sizedCappedTrades = 0;
    let sizedTotalStaked = 0;
    let sizedMaxStake = 0;
    let sizedGrossProfit = 0;
    let sizedGrossLoss = 0;
    const equityCheckpoints: Array<{ time: Time; value: number }> = [];

    const trades = result.trades.map((trade): Trade => {
        const payoutResult = resolvePolymarketTradePayout(trade);
        if (!payoutResult.payout) {
            sizedSkippedTrades++;
            return trade;
        }

        if (equity <= 0) {
            sizedNoCapitalTrades++;
            return trade;
        }

        const entryBarIndex = timeIndex ? getTradeEntryBarIndex(trade, timeIndex) : 0;
        if (timeIndex && entryBarIndex === null) {
            sizedSkippedTrades++;
            return trade;
        }

        const resolvedEntryBarIndex = entryBarIndex ?? 0;
        const sizingBarIndex = needsChartBar && executionModel === "next_open"
            ? resolvedEntryBarIndex - 1
            : resolvedEntryBarIndex;
        const direction = trade.type;
        const rawStake = resolveAllocatedCapital(
            sizingMode,
            equity,
            capitalSettings.positionSize,
            POLYMARKET_BASE_TRADE_AMOUNT,
            chartData,
            sizingBarIndex,
            direction,
            trade.entryPrice,
            sizingBarIndex >= 0 ? atr[sizingBarIndex] ?? null : null,
            sizingState,
            advancedSizing
        );

        if (!Number.isFinite(rawStake) || rawStake <= 0) {
            sizedSkippedTrades++;
            return trade;
        }

        const targetStake = equity >= POLYMARKET_BASE_TRADE_AMOUNT
            ? Math.max(rawStake, POLYMARKET_BASE_TRADE_AMOUNT)
            : rawStake;
        const stake = Math.min(targetStake, equity);
        const stakeCapped = stake < targetStake;
        if (stakeCapped) {
            sizedCappedTrades++;
        }

        const shares = stake / payoutResult.payout.entryPrice;
        const sizedPnl = shares * payoutResult.payout.sharePnl;
        const sizedPnlPercent = stake > 0 ? (sizedPnl / stake) * 100 : 0;
        const equityBefore = equity;
        equity += sizedPnl;
        const equityAfter = equity;

        sizedTrades++;
        sizedTotalStaked += stake;
        sizedMaxStake = Math.max(sizedMaxStake, stake);
        if (sizedPnl > 0) {
            sizedGrossProfit += sizedPnl;
        } else if (sizedPnl < 0) {
            sizedGrossLoss += Math.abs(sizedPnl);
        }
        equityCheckpoints.push({ time: getEquityCheckpointTime(trade), value: equityAfter });
        updatePolymarketSizingState(
            sizingState,
            sizingMode,
            sizedPnl,
            payoutResult.payout.sharePnl / payoutResult.payout.entryPrice,
            advancedSizing
        );

        return {
            ...trade,
            polymarketOutcome: {
                ...trade.polymarketOutcome!,
                sizedStake: stake,
                sizedShares: shares,
                sizedPnl,
                sizedPnlPercent,
                sizedEquityBefore: equityBefore,
                sizedEquityAfter: equityAfter,
                sizedSizingMode: sizingMode,
                sizedStakeCapped: stakeCapped || undefined,
            },
        };
    });

    const sizedNetProfit = equity - capitalSettings.initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCheckpoints, capitalSettings.initialCapital);

    return {
        ...result,
        trades,
        polymarketTradeSummary: {
            ...result.polymarketTradeSummary,
            seriesId: result.polymarketTradeSummary?.seriesId ?? "",
            outcomeRowsLoaded: result.polymarketTradeSummary?.outcomeRowsLoaded ?? 0,
            scoredTrades: result.polymarketTradeSummary?.scoredTrades ?? 0,
            missingOutcomeTrades: result.polymarketTradeSummary?.missingOutcomeTrades ?? 0,
            sizedSizingMode: sizingMode,
            sizedInitialCapital: capitalSettings.initialCapital,
            sizedFinalEquity: equity,
            sizedNetProfit,
            sizedNetProfitPercent: capitalSettings.initialCapital > 0
                ? (sizedNetProfit / capitalSettings.initialCapital) * 100
                : 0,
            sizedGrossProfit,
            sizedGrossLoss,
            sizedProfitFactor: getProfitFactor(sizedGrossProfit, sizedGrossLoss),
            sizedExpectancy: sizedTrades > 0 ? sizedNetProfit / sizedTrades : 0,
            sizedMaxDrawdown: maxDrawdown,
            sizedMaxDrawdownPercent: maxDrawdownPercent,
            sizedTrades,
            sizedSkippedTrades: sizedSkippedTrades + sizedNoCapitalTrades,
            sizedNoCapitalTrades,
            sizedCappedTrades,
            sizedTotalStaked,
            sizedAvgStake: sizedTrades > 0 ? sizedTotalStaked / sizedTrades : 0,
            sizedMaxStake,
        },
    };
}
