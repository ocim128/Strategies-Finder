import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 36))),
    };
}

export const window_giveback_distribution_climax: Strategy = {
    name: "Window Giveback Distribution Climax",
    description: "Fades parabolic non-retracing window excursions when giveback percentile ranks in the bottom 5%.",
    defaultParams: {
        lookback: 36,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < Math.max(lookback, 24) + 1) return [];

        const gb = buildWindowGivebackRatio(cleanData, 24);
        const gbValues = gb.map((v) => (v !== null ? v : NaN));
        const pctGb = buildPercentileRank(gbValues, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [pctGb], (i) => {
            if (i < 24) return null;
            const pctl = pctGb[i];
            if (pctl === null || pctl > 0.05) return null;

            // Parabolic down-window (zero retracement) with bull turning candle -> buy snapback
            if (closes[i] < closes[i - 24] && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish climax giveback snap: giveback pctl ${pctl.toFixed(2)} <= 0.05, down-window, bull close`);
            }

            // Parabolic up-window (zero retracement) with bear turning candle -> sell snapback
            if (closes[i] >= closes[i - 24] && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish climax giveback snap: giveback pctl ${pctl.toFixed(2)} <= 0.05, up-window, bear close`);
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
