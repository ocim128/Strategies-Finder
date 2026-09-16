import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildExtremeAgeSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 24))),
    };
}

export const extreme_age_symmetrical_collapse_thrust: Strategy = {
    name: "Extreme Age Symmetrical Collapse Thrust",
    description: "Trades outside engulfing bars that take out both window extremes simultaneously, following decisive close location.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow, clsLoc], (i) => {
            const sH = sinceHigh[i];
            const sL = sinceLow[i];
            const loc = clsLoc[i];
            if (sH === null || sL === null || loc === null) return null;

            if (sH <= 1 && sL <= 1) {
                if (loc >= 0.75) {
                    return createBuySignal(cleanData, i, `Bullish symmetrical collapse: dual extremes aged <= 1, close location ${loc.toFixed(3)} >= 0.75`);
                }
                if (loc <= 0.25) {
                    return createSellSignal(cleanData, i, `Bearish symmetrical collapse: dual extremes aged <= 1, close location ${loc.toFixed(3)} <= 0.25`);
                }
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
