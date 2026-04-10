import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeReturnSkewnessCapitulationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        skew_lookback: Math.max(3, Math.round(params.skew_lookback ?? 30)),
        skew_extreme_threshold: Number(params.skew_extreme_threshold ?? -2.0)
    };
}

export const return_skewness_capitulation: Strategy = {
    name: "Return Skewness Capitulation",
    description: "Extreme return skewness isolates panic cascades and margin calls. A counter-trend close in a deeply skewed regime signals that weak hands have fully capitulated.",
    defaultParams: {
        skew_lookback: 30,
        skew_extreme_threshold: -2.0
    },
    paramLabels: {
        skew_lookback: "Skewness Lookback",
        skew_extreme_threshold: "Skewness Extreme Threshold"
    },
    normalizeParams: normalizeReturnSkewnessCapitulationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnSkewnessCapitulationParams(params);
        if (cleanData.length < (p.skew_lookback as number)) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, 1);
        const mappedReturns = roc.map(r => (r === null || r === 0) ? 0.0000001 * (Math.random() - 0.5) : r);
        const skewness = buildRollingSkewness(mappedReturns, p.skew_lookback as number);

        return createSignalLoop(cleanData, [skewness], (i) => {
            if (i < (p.skew_lookback as number)) return null;
            const skew = skewness[i];
            if (skew === null) return null;

            const isUpCandle = cleanData[i].close > cleanData[i].open;
            const isDownCandle = cleanData[i].close < cleanData[i].open;
            const thresh = p.skew_extreme_threshold as number;

            if (skew < thresh && isUpCandle) {
                return createBuySignal(cleanData, i, `Skewness < ${thresh} and up-candle`);
            }
            if (skew > Math.abs(thresh) && isDownCandle) {
                return createSellSignal(cleanData, i, `Skewness > ${Math.abs(thresh)} and down-candle`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["skew_lookback", "skew_extreme_threshold"]
    }
};
