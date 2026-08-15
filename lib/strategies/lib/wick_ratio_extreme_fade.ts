import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const WICK_RATIO_HIGH_BAND = 0.9;
const WICK_RATIO_LOW_BAND = 0.1;

function normalizeWickRatioExtremeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const wick_ratio_extreme_fade: Strategy = {
    name: "Wick Ratio Extreme Fade",
    description: "Fades bars where the lower-wick share of total wick length sits at a percentile extreme, reading which side keeps getting absorbed.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWickRatioExtremeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeWickRatioExtremeFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const lowerWick = extractBarMetricSeries(cleanData, "lowerWick");
        const upperWick = extractBarMetricSeries(cleanData, "upperWick");
        const ratio: number[] = new Array(cleanData.length).fill(Number.NaN);
        for (let i = 0; i < cleanData.length; i++) {
            const total = lowerWick[i] + upperWick[i];
            if (total > 0) {
                ratio[i] = lowerWick[i] / total;
            }
        }
        const pct = buildPercentileRank(ratio, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            if (i < lookback) return null;
            const rank = pct[i];
            if (rank === null) return null;

            if (rank > WICK_RATIO_HIGH_BAND) {
                return createBuySignal(cleanData, i, `Wick ratio fade buy: lower-wick share rank ${rank.toFixed(2)}, declines absorbed`);
            }
            if (rank < WICK_RATIO_LOW_BAND) {
                return createSellSignal(cleanData, i, `Wick ratio fade sell: lower-wick share rank ${rank.toFixed(2)}, rallies absorbed`);
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
