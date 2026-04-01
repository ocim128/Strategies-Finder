import { ADVANCED_SIZING_DEFAULTS } from "../../advanced-sizing-settings";
import type { AdvancedSizingSettings } from "../../types/backtest";
import { clamp } from "./shared";

export interface KellyTradeSample {
    pnl: number;
    isWin: boolean;
}

export interface KellySizingState {
    tradeHistory: KellyTradeSample[];
}

export interface KellyResult {
    rawKellyFraction: number;
    cappedKellyFraction: number;
    appliedFraction: number;
    isValid: boolean;
    winRate: number;
    profitFactor: number;
    averageWin: number;
    averageLoss: number;
    tradeCount: number;
}

function resolveKellyFractionMultiplier(fraction: AdvancedSizingSettings["kellyFraction"] | undefined): number {
    switch (fraction) {
        case "full":
            return 1;
        case "quarter":
            return 0.25;
        default:
            return 0.5;
    }
}

export function createKellySizingState(): KellySizingState {
    return { tradeHistory: [] };
}

export function updateKellyState(
    state: KellySizingState,
    tradeResult: KellyTradeSample,
    maxLookback = 100
): KellySizingState {
    state.tradeHistory.push({
        pnl: tradeResult.pnl,
        isWin: tradeResult.isWin,
    });
    if (state.tradeHistory.length > maxLookback) {
        state.tradeHistory.shift();
    }
    return state;
}

export function calculateKelly(
    state: KellySizingState | undefined,
    settings?: AdvancedSizingSettings
): KellyResult {
    const tradeHistory = state?.tradeHistory ?? [];
    const wins = tradeHistory.filter((trade) => trade.isWin && trade.pnl > 0);
    const losses = tradeHistory.filter((trade) => !trade.isWin && trade.pnl < 0);
    const tradeCount = wins.length + losses.length;
    const totalWinAmount = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const totalLossAmount = losses.reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
    const averageWin = wins.length > 0 ? totalWinAmount / wins.length : 0;
    const averageLoss = losses.length > 0 ? totalLossAmount / losses.length : 0;
    const rawWinRate = tradeCount > 0 ? wins.length / tradeCount : 0;
    const winRate = Math.min(rawWinRate, settings?.kellyWinRateCap ?? ADVANCED_SIZING_DEFAULTS.kellyWinRateCap);
    const payoffRatio = averageLoss > 0 ? averageWin / averageLoss : 0;
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0;
    const rawKellyFraction = payoffRatio > 0 ? winRate - ((1 - winRate) / payoffRatio) : 0;
    const cappedKellyFraction = clamp(rawKellyFraction, 0, 0.25);
    const appliedFraction = cappedKellyFraction * resolveKellyFractionMultiplier(settings?.kellyFraction);
    const isValid = tradeCount >= 5
        && averageLoss > 0
        && profitFactor >= (settings?.kellyProfitFactorCap ?? ADVANCED_SIZING_DEFAULTS.kellyProfitFactorCap)
        && appliedFraction > 0;

    return {
        rawKellyFraction,
        cappedKellyFraction,
        appliedFraction,
        isValid,
        winRate: rawWinRate,
        profitFactor,
        averageWin,
        averageLoss,
        tradeCount,
    };
}
