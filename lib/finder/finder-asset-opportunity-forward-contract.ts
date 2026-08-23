import type { OHLCVData } from "../types/strategies";
import { applySlippage, entrySideForDirection, exitSideForDirection } from "../strategies/backtest/backtest-utils";

export type FinderAssetOpportunityForwardExitReason = "take_profit" | "stop_loss" | "end_of_data";

export interface FinderAssetOpportunityForwardOutcome {
    exitReason: FinderAssetOpportunityForwardExitReason;
    barsHeld: number;
    netReturnPercent: number;
    entryPrice: number;
    exitPrice: number;
}

export interface FinderAssetOpportunityForwardContractInput {
    candles: OHLCVData[];
    direction: "long" | "short";
    entryPrice: number;
    entryBarIndex: number;
    takeProfitPrice: number | null;
    stopLossPrice: number | null;
    horizonBars: number;
    executionModel: "signal_close" | "next_open" | "next_close";
    allowSameBarExit: boolean;
    slippageBps: number;
    commissionPercent: number;
}

function isFinitePrice(value: number | null): value is number {
    return value !== null && Number.isFinite(value) && value > 0;
}

function hitStop(candle: OHLCVData, price: number, direction: "long" | "short"): boolean {
    return direction === "short" ? candle.high >= price : candle.low <= price;
}

function hitTakeProfit(candle: OHLCVData, price: number, direction: "long" | "short"): boolean {
    return direction === "short" ? candle.low <= price : candle.high >= price;
}

function stopFill(candle: OHLCVData, stopPrice: number, direction: "long" | "short"): number {
    if (!Number.isFinite(candle.open)) return stopPrice;
    if (direction === "short" && candle.open >= stopPrice) return candle.open;
    if (direction === "long" && candle.open <= stopPrice) return candle.open;
    return stopPrice;
}

function netReturnPercent(
    entryPrice: number,
    exitPrice: number,
    direction: "long" | "short",
    slippageBps: number,
    commissionPercent: number,
): { entryPrice: number; exitPrice: number; netReturnPercent: number } {
    const slippageRate = Math.max(0, slippageBps) / 10_000;
    const entryFill = applySlippage(entryPrice, entrySideForDirection(direction), slippageRate);
    const exitFill = applySlippage(exitPrice, exitSideForDirection(direction), slippageRate);
    const gross = direction === "long"
        ? (exitFill - entryFill) / entryFill
        : (entryFill - exitFill) / entryFill;
    const commissionRate = Math.max(0, commissionPercent) / 100;
    const roundTripCommission = commissionRate * (1 + Math.abs(exitFill / entryFill));
    return {
        entryPrice: entryFill,
        exitPrice: exitFill,
        netReturnPercent: (gross - roundTripCommission) * 100,
    };
}

/**
 * Execute one declared forward trade over a bounded horizon. The caller has
 * already resolved the candidate's risk settings and entry price; this leaf
 * owns only the shared first-touch rules and cost accounting.
 */
export function simulateFinderAssetOpportunityForwardOutcome(
    input: FinderAssetOpportunityForwardContractInput,
): FinderAssetOpportunityForwardOutcome | null {
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) return null;
    if (!Number.isInteger(input.entryBarIndex) || input.entryBarIndex < 0) return null;
    if (!Number.isInteger(input.horizonBars) || input.horizonBars <= 0) return null;
    if (input.entryBarIndex >= input.candles.length) return null;

    const isNextEntry = input.executionModel !== "signal_close";
    const sameBarStopOnly = isNextEntry && !input.allowSameBarExit;
    const firstExitIndex = isNextEntry ? input.entryBarIndex : input.entryBarIndex + 1;
    const lastExitIndex = Math.min(input.candles.length - 1, firstExitIndex + input.horizonBars - 1);
    const takeProfit = isFinitePrice(input.takeProfitPrice) ? input.takeProfitPrice : null;
    const stopLoss = isFinitePrice(input.stopLossPrice) ? input.stopLossPrice : null;

    for (let index = firstExitIndex; index <= lastExitIndex; index += 1) {
        const candle = input.candles[index];
        if (!candle) continue;
        // The engine checks stop loss before take profit on a candle that
        // touches both. For next_open + allowSameBarExit=false, its explicit
        // same-bar guard permits only the protective stop on the entry bar.
        if (stopLoss !== null && hitStop(candle, stopLoss, input.direction)) {
            const exit = stopFill(candle, stopLoss, input.direction);
            const net = netReturnPercent(
                input.entryPrice,
                exit,
                input.direction,
                input.slippageBps,
                input.commissionPercent,
            );
            return {
                exitReason: "stop_loss",
                barsHeld: Math.max(0, index - input.entryBarIndex),
                ...net,
            };
        }
        if ((!sameBarStopOnly || index !== input.entryBarIndex)
            && takeProfit !== null
            && hitTakeProfit(candle, takeProfit, input.direction)) {
            const net = netReturnPercent(
                input.entryPrice,
                takeProfit,
                input.direction,
                input.slippageBps,
                input.commissionPercent,
            );
            return {
                exitReason: "take_profit",
                barsHeld: Math.max(0, index - input.entryBarIndex),
                ...net,
            };
        }
    }

    const finalIndex = lastExitIndex >= firstExitIndex ? lastExitIndex : input.entryBarIndex;
    const finalCandle = input.candles[finalIndex];
    if (!finalCandle) return null;
    const net = netReturnPercent(
        input.entryPrice,
        finalCandle.close,
        input.direction,
        input.slippageBps,
        input.commissionPercent,
    );
    return {
        exitReason: "end_of_data",
        barsHeld: Math.max(0, finalIndex - input.entryBarIndex),
        ...net,
    };
}
