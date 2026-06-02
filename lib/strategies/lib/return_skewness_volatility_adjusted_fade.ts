import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingSkewness, buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming return skewness extremes coupled with extreme close Z-score identify exhaust reversion points.
// #SUGGEST_VERIFY: Verify return skewness lookback (>= 3) and skewLimit (> 0).
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 45))),
        skewLimit: Math.max(0.1, Number(params.skewLimit ?? 1.3)),
    };
}

export const return_skewness_volatility_adjusted_fade: Strategy = {
    name: "Return Skewness Volatility Adjusted Fade",
    description: "Fades price extremes when they are accompanied by opposite extreme return skewness, showing exhaustion.",
    defaultParams: {
        lookback: 45,
        skewLimit: 1.3,
    },
    paramLabels: {
        lookback: "Lookback",
        skewLimit: "Skew Limit",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const skewLimit = p.skewLimit as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skewness = buildRollingSkewness(returns, lookback);
        const zScores = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [skewness, zScores], (i) => {
            const skew = skewness[i];
            const z = zScores[i];
            if (skew === null || z === null) return null;

            // Buy: Z-score is extremely oversold, skewness is positive (outlier bullish returns recently, indicating panic selling exhaustion and high probability of snapback)
            if (z < -2.0 && skew > skewLimit) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Oversold Z-score (${z.toFixed(2)}) with positive return skewness (${skew.toFixed(2)} > ${skewLimit})`
                );
            }

            // Sell: Z-score is extremely overbought, skewness is negative (outlier bearish returns recently, indicating euphoria buying exhaustion and high probability of snapback)
            if (z > 2.0 && skew < -skewLimit) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Overbought Z-score (${z.toFixed(2)}) with negative return skewness (${skew.toFixed(2)} < -${skewLimit})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewLimit"],
    },
};
