import type { BacktestSettings, OHLCVData } from "../types/strategies";
import type { FinderAssetOpportunityForwardOutcomeSummary } from "./finder-asset-opportunity-research-types";
import {
    applySlippage,
    entrySideForDirection,
    exitSideForDirection,
    timeKey,
} from "../strategies/backtest/backtest-utils";

export type FinderAssetOpportunityForwardOutcome = FinderAssetOpportunityForwardOutcomeSummary;
export type FinderAssetOpportunityForwardExitReason = FinderAssetOpportunityForwardOutcome["exitReason"];

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

function comparisonTolerance(left: number, right: number): number {
    const magnitude = Math.max(Math.abs(left), Math.abs(right));
    return magnitude > 0 ? magnitude * 1e-10 : 1e-12;
}

function greaterThanOrNearlyEqual(left: number, right: number): boolean {
    return left > right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

function lessThanOrNearlyEqual(left: number, right: number): boolean {
    return left < right || Math.abs(left - right) <= comparisonTolerance(left, right);
}

function hitStop(candle: OHLCVData, price: number, direction: "long" | "short"): boolean {
    return direction === "short"
        ? greaterThanOrNearlyEqual(candle.high, price)
        : lessThanOrNearlyEqual(candle.low, price);
}

function hitTakeProfit(candle: OHLCVData, price: number, direction: "long" | "short"): boolean {
    return direction === "short"
        ? lessThanOrNearlyEqual(candle.low, price)
        : greaterThanOrNearlyEqual(candle.high, price);
}

function stopFill(candle: OHLCVData, stopPrice: number, direction: "long" | "short"): number {
    if (!Number.isFinite(candle.open)) return stopPrice;
    if (direction === "short" && greaterThanOrNearlyEqual(candle.open, stopPrice)) return candle.open;
    if (direction === "long" && lessThanOrNearlyEqual(candle.open, stopPrice)) return candle.open;
    return stopPrice;
}

function netReturnPercent(
    entryPrice: number,
    exitPrice: number,
    direction: "long" | "short",
    slippageBps: number,
    commissionPercent: number,
    applyExitSlippage = true,
): {
    entryPrice: number;
    exitPrice: number;
    grossReturnPercent: number;
    slippagePercent: number;
    commissionPercent: number;
    netReturnPercent: number;
} {
    const slippageRate = Math.max(0, slippageBps) / 10_000;
    const entryFill = applySlippage(entryPrice, entrySideForDirection(direction), slippageRate);
    const exitFill = applyExitSlippage
        ? applySlippage(exitPrice, exitSideForDirection(direction), slippageRate)
        : exitPrice;
    const rawGross = direction === "long"
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
    const filledGross = direction === "long"
        ? (exitFill - entryFill) / entryFill
        : (entryFill - exitFill) / entryFill;
    const commissionRate = Math.max(0, commissionPercent) / 100;
    const entryCommission = entryFill * commissionRate;
    const exitCommission = exitFill * commissionRate;
    const roundTripCommission = (entryCommission + exitCommission) / entryFill;
    const rawPnlPerUnit = direction === "long"
        ? exitFill - entryFill
        : entryFill - exitFill;
    const netReturn = (rawPnlPerUnit - entryCommission - exitCommission) / entryFill;
    return {
        entryPrice: entryFill,
        exitPrice: exitFill,
        grossReturnPercent: rawGross * 100,
        slippagePercent: (rawGross - filledGross) * 100,
        commissionPercent: roundTripCommission * 100,
        netReturnPercent: netReturn * 100,
    };
}

/**
 * The fresh-window program has one execution contract. Keeping this check in
 * a dependency-light leaf lets the HTTP route and the S0 analyzer enforce the
 * same rule without each inventing its own defaults.
 */
export function validateFreshWindowExecutionSettings(settings: BacktestSettings): string[] {
    const reasons: string[] = [];
    const stopLossPercent = Number(settings.stopLossPercent);
    const takeProfitPercent = Number(settings.takeProfitPercent);
    if (settings.tradeDirection !== "long") {
        reasons.push(`tradeDirection must be long (got ${String(settings.tradeDirection)})`);
    }
    if (settings.executionModel !== "next_open") {
        reasons.push(`executionModel must be next_open (got ${String(settings.executionModel)})`);
    }
    if (settings.allowSameBarExit !== false) {
        reasons.push(`allowSameBarExit must be false (got ${String(settings.allowSameBarExit)})`);
    }
    if (settings.riskMode !== "percentage") {
        reasons.push(`riskMode must be percentage (got ${String(settings.riskMode)})`);
    }
    if (settings.stopLossEnabled !== true || !Number.isFinite(stopLossPercent)
        || stopLossPercent <= 0) {
        reasons.push("stop-loss must be enabled with a positive percentage");
    }
    if (settings.takeProfitEnabled !== true || !Number.isFinite(takeProfitPercent)
        || takeProfitPercent <= 0) {
        reasons.push("take-profit must be enabled with a positive percentage");
    }
    return reasons;
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
                entryTimestamp: timeKey(input.candles[input.entryBarIndex]!.time),
                exitTimestamp: timeKey(candle.time),
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
                entryTimestamp: timeKey(input.candles[input.entryBarIndex]!.time),
                exitTimestamp: timeKey(candle.time),
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
        false,
    );
    return {
        exitReason: "end_of_data",
        barsHeld: Math.max(0, finalIndex - input.entryBarIndex),
        entryTimestamp: timeKey(input.candles[input.entryBarIndex]!.time),
        exitTimestamp: timeKey(finalCandle.time),
        ...net,
    };
}
