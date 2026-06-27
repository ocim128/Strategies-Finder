import type { OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import {
    buildTrailingRatioHighLow,
    getAtrSeries,
    getPreparedRelativeStrengthRangeData,
    hasDirectionalAcceptance,
    hasEnoughBars,
    isOverextendedMove,
    normalizeIntegerParam,
    normalizeNumberParam,
    prepareRelativeStrengthRangeData,
} from "./relative-strength-range-core";

const ATR_PERIOD = 14;
const ACCEPTANCE_MIN = 0;

function normalizeRelativeAcceptanceBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        breakout_lookback: normalizeIntegerParam(params.breakout_lookback, 22, 8, 120),
        max_range_atr: normalizeNumberParam(params.max_range_atr, 2.45, 0.5, 10),
    };
}

function executeRelativeAcceptanceBreakout(preparedData: unknown, params: StrategyParams, data: OHLCVData[]) {
    const prepared = getPreparedRelativeStrengthRangeData(preparedData, data);
    const p = normalizeRelativeAcceptanceBreakoutParams(params);
    const breakoutLookback = p.breakout_lookback as number;
    const atrPeriod = ATR_PERIOD;
    if (!hasEnoughBars(prepared.cleanData, Math.max(breakoutLookback, atrPeriod) + 2)) return [];

    const levels = buildTrailingRatioHighLow(prepared, breakoutLookback);
    const atr = getAtrSeries(prepared, atrPeriod);

    return createSignalLoop(prepared.cleanData, [levels.highest, levels.lowest, atr], (i) => {
        if (i < Math.max(breakoutLookback, atrPeriod)) return null;
        const priorHigh = levels.highest[i];
        const priorLow = levels.lowest[i];
        if (priorHigh === null || priorLow === null) return null;
        if (isOverextendedMove(prepared, i, atr, p.max_range_atr as number, 0.07)) return null;

        if (prepared.closes[i] > priorHigh && hasDirectionalAcceptance(prepared, i, ACCEPTANCE_MIN, 1)) {
            return createBuySignal(prepared.cleanData, i, "Relative acceptance breakout above prior ratio high");
        }
        if (prepared.closes[i] < priorLow && hasDirectionalAcceptance(prepared, i, ACCEPTANCE_MIN, -1)) {
            return createSellSignal(prepared.cleanData, i, "Relative acceptance breakdown below prior ratio low");
        }
        return null;
    });
}

// Captures confirmed relative breakouts that close beyond prior ratio structure with acceptance.
export const relative_acceptance_breakout: Strategy = {
    name: "Relative Acceptance Breakout",
    description: "Trades synthetic-ratio breakouts only when the candle closes beyond prior structure with accepted direction and non-extreme range.",
    defaultParams: {
        breakout_lookback: 22,
        max_range_atr: 2.45,
    },
    paramLabels: {
        breakout_lookback: "Breakout Lookback",
        max_range_atr: "Max Range / ATR",
    },
    normalizeParams: normalizeRelativeAcceptanceBreakoutParams,
    prepareFinderData: (data) => prepareRelativeStrengthRangeData(data),
    executePrepared: executeRelativeAcceptanceBreakout,
    execute: (data, params) => executeRelativeAcceptanceBreakout(prepareRelativeStrengthRangeData(data), params, data),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["breakout_lookback", "max_range_atr"],
    },
};
