import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const median_extreme_envelope_breakout: Strategy = {
    name: "Median Extreme Envelope Breakout",
    description: "Enters when the close breaks the trailing median of highs or median of lows.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Envelope Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const medHigh = buildRollingMedian(getHighs(cleanData), lookback);
        const medLow = buildRollingMedian(getLows(cleanData), lookback);

        return createSignalLoop(cleanData, [medHigh, medLow], (i) => {
            const highMedian = medHigh[i];
            const lowMedian = medLow[i];
            if (highMedian === null || lowMedian === null) return null;

            if (closes[i] > highMedian) {
                return createBuySignal(cleanData, i, "Close above median of highs");
            }
            if (closes[i] < lowMedian) {
                return createSellSignal(cleanData, i, "Close below median of lows");
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
