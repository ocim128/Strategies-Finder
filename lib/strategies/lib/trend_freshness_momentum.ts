import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingMinMax } from "./price-action-statistics-core";

const FRESH_HIGH_BAND = 0.8;
const FRESH_LOW_BAND = 0.2;

function normalizeTrendFreshnessMomentumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const trend_freshness_momentum: Strategy = {
    name: "Trend Freshness Momentum",
    description: "Takes lookback momentum only when the close sits near the top or bottom band of its own trailing close range.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTrendFreshnessMomentumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeTrendFreshnessMomentumParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const momentum = buildRateOfChange(closes, lookback);
        const { min, max } = buildRollingMinMax(closes, lookback);

        return createSignalLoop(cleanData, [momentum], (i) => {
            if (i < lookback) return null;
            const roc = momentum[i];
            const lo = min[i];
            const hi = max[i];
            if (roc === null || lo === null || hi === null || hi <= lo) return null;
            const position = (closes[i] - lo) / (hi - lo);

            if (roc > 0 && position > FRESH_HIGH_BAND) {
                return createBuySignal(cleanData, i, `Fresh momentum buy: roc ${roc.toFixed(4)}, close position ${position.toFixed(2)} in window`);
            }
            if (roc < 0 && position < FRESH_LOW_BAND) {
                return createSellSignal(cleanData, i, `Fresh momentum sell: roc ${roc.toFixed(4)}, close position ${position.toFixed(2)} in window`);
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
