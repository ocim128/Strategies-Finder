import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 24))),
    };
}

export const extreme_age_micro_double_top_fade: Strategy = {
    name: "Extreme Age Micro Double Top Fade",
    description: "Fades failed immediate re-tests of recent extremes when a fresh extreme printed 2 to 4 bars after a recent extreme fails to close higher.",
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
        if (cleanData.length < lookback + 1) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const prevLowAge = sinceLow[i - 1];
            const currLowAge = sinceLow[i];
            const prevHighAge = sinceHigh[i - 1];
            const currHighAge = sinceHigh[i];

            if (prevLowAge !== null && prevLowAge >= 2 && prevLowAge <= 4 && currLowAge === 0 && cleanData[i].close > cleanData[i - 1].close) {
                return createBuySignal(cleanData, i, `Bullish micro double bottom fade: fresh low (0) after prior age ${prevLowAge} in [2, 4], close > prior close`);
            }
            if (prevHighAge !== null && prevHighAge >= 2 && prevHighAge <= 4 && currHighAge === 0 && cleanData[i].close < cleanData[i - 1].close) {
                return createSellSignal(cleanData, i, `Bearish micro double top fade: fresh high (0) after prior age ${prevHighAge} in [2, 4], close < prior close`);
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
