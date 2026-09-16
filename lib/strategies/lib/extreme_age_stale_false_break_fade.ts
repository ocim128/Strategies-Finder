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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 40))),
    };
}

export const extreme_age_stale_false_break_fade: Strategy = {
    name: "Extreme Age Stale False Break Fade",
    description: "Fades false breakouts when price breaches an extreme that stood unchallenged for nearly the entire window but fails back inside.",
    defaultParams: {
        lookback: 40,
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
        const staleMin = lookback - 2;

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const prevH = sinceHigh[i - 1];
            const currH = sinceHigh[i];
            const prevL = sinceLow[i - 1];
            const currL = sinceLow[i];

            if (prevL !== null && prevL >= staleMin && currL === 0 && cleanData[i].close > cleanData[i - 1].low) {
                return createBuySignal(cleanData, i, `Bullish stale break failure: prior low age ${prevL} >= ${staleMin}, reset to 0, close > prior low`);
            }
            if (prevH !== null && prevH >= staleMin && currH === 0 && cleanData[i].close < cleanData[i - 1].high) {
                return createSellSignal(cleanData, i, `Bearish stale break failure: prior high age ${prevH} >= ${staleMin}, reset to 0, close < prior high`);
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
