import { OHLCVData, Trade } from "../../types/index";
import { NormalizedSettings, PositionState } from "../../types/backtest";
import { directionFactorFor } from "./backtest-utils";

export interface AdaptiveTakeProfitOverrides {
    takeProfitPrice: number | null;
}

export interface AdaptiveTakeProfitState {
    longWinningMfePercents: number[];
    shortWinningMfePercents: number[];
}

function calculatePercentile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];

    const rank = (Math.max(1, Math.min(99, percentile)) / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    if (lowerIndex === upperIndex) return sorted[lowerIndex];

    const weight = rank - lowerIndex;
    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

function clampNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toTargetPrice(entryPrice: number, direction: "long" | "short", percent: number): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(percent) || percent <= 0) {
        return null;
    }

    const directionFactor = directionFactorFor(direction);
    return entryPrice * (1 + directionFactor * (percent / 100));
}

function getDirectionHistory(
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number[] {
    return direction === "long" ? state.longWinningMfePercents : state.shortWinningMfePercents;
}

function getRecentWinningMfePercents(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number[] {
    const history = getDirectionHistory(state, direction);
    const lookback = Math.max(1, config.takeProfitMfeLookbackTrades);
    return history.length <= lookback ? history : history.slice(history.length - lookback);
}

function resolveRollingMfePercent(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short"
): number {
    const recentHistory = getRecentWinningMfePercents(config, state, direction);
    return clampNonNegative(
        calculatePercentile(recentHistory, config.takeProfitMfePercentile) ?? config.takeProfitPercent
    );
}

export function createAdaptiveTakeProfitState(
    _data: OHLCVData[],
    _config: NormalizedSettings
): AdaptiveTakeProfitState {
    return {
        longWinningMfePercents: [],
        shortWinningMfePercents: [],
    };
}

export function resolveAdaptiveTakeProfitOverrides(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    direction: "long" | "short",
    entryPrice: number
): AdaptiveTakeProfitOverrides | null {
    if (config.riskMode !== "percentage" || config.takeProfitEnabled !== true) {
        return null;
    }

    const adaptivePercent = config.takeProfitMode === "shrinkage"
        ? (() => {
            const pairEstimate = resolveRollingMfePercent(config, state, direction);
            const recentHistory = getRecentWinningMfePercents(config, state, direction);
            const sampleWeight = recentHistory.length / (recentHistory.length + config.takeProfitShrinkageStrength);
            return clampNonNegative(
                sampleWeight * pairEstimate + (1 - sampleWeight) * config.takeProfitPercent
            );
        })()
        : clampNonNegative(config.takeProfitPercent);

    return {
        takeProfitPrice: toTargetPrice(entryPrice, direction, adaptivePercent),
    };
}

export function updateAdaptiveTakeProfitHistory(
    config: NormalizedSettings,
    state: AdaptiveTakeProfitState,
    position: PositionState,
    exitPrice: number,
    exitReason: NonNullable<Trade["exitReason"]>,
    candle: OHLCVData
): void {
    if (config.riskMode !== "percentage") return;
    if (config.takeProfitMode !== "shrinkage") return;
    if (!Number.isFinite(position.realizedPnl) || position.realizedPnl <= 0) return;
    if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) return;
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;

    const canUseFullExitBarRange =
        exitReason === "time_stop"
        || (exitReason === "signal" && config.executionModel !== "next_open");

    const mostFavorablePrice = position.direction === "short"
        ? (canUseFullExitBarRange
            ? Math.min(position.extremePrice, candle.low)
            : Math.min(position.extremePrice, exitPrice))
        : (canUseFullExitBarRange
            ? Math.max(position.extremePrice, candle.high)
            : Math.max(position.extremePrice, exitPrice));
    const mfePercent = Math.abs(((mostFavorablePrice - position.entryPrice) / position.entryPrice) * 100);
    if (!Number.isFinite(mfePercent) || mfePercent <= 0) return;

    const history = getDirectionHistory(state, position.direction);
    history.push(mfePercent);

    const maxHistory = Math.max(25, config.takeProfitMfeLookbackTrades * 2);
    if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
    }
}
