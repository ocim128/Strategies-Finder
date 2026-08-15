import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const BREAK_PERCENTILE_BAND = 0.85;

function normalizeImmediateRangeBreakAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const immediate_range_break_acceptance: Strategy = {
    name: "Immediate Range Break Acceptance",
    description: "Buys or sells closes that decisively clear the prior bar's range at a high percentile with positive close acceptance.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeImmediateRangeBreakAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeImmediateRangeBreakAcceptanceParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const breakUp: number[] = new Array(cleanData.length).fill(0);
        const breakDown: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const priorRange = computePriceActionBarMetrics(cleanData[i - 1]).range;
            if (priorRange > 0) {
                breakUp[i] = (cleanData[i].close - cleanData[i - 1].high) / priorRange;
                breakDown[i] = (cleanData[i - 1].low - cleanData[i].close) / priorRange;
            }
        }
        const upPct = buildPercentileRank(breakUp, lookback);
        const downPct = buildPercentileRank(breakDown, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [upPct, downPct], (i) => {
            if (i < lookback) return null;
            const upRank = upPct[i];
            const downRank = downPct[i];
            if (upRank === null || downRank === null) return null;

            if (upRank > BREAK_PERCENTILE_BAND && acceptance[i] > 0) {
                return createBuySignal(cleanData, i, `Immediate range break buy: up-break rank ${upRank.toFixed(2)} with positive acceptance`);
            }
            if (downRank > BREAK_PERCENTILE_BAND && acceptance[i] < 0) {
                return createSellSignal(cleanData, i, `Immediate range break sell: down-break rank ${downRank.toFixed(2)} with negative acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
