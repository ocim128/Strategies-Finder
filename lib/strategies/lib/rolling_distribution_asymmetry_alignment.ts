import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness, extractBarMetricSeries } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming return distribution asymmetry (skewness) acts as a leading indicator of breakouts.
// #SUGGEST_VERIFY: Verify return skewness lookback (>= 3) and skewThreshold (> 0).
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 45))),
        skewThreshold: Math.max(0.1, Number(params.skewThreshold ?? 1.5)),
    };
}

export const rolling_distribution_asymmetry_alignment: Strategy = {
    name: "Rolling Distribution Asymmetry Alignment",
    description: "Enters directional breakouts when return skewness and average return align in positive/negative territory.",
    defaultParams: {
        lookback: 45,
        skewThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Skew Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const skewThreshold = p.skewThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skewness = buildRollingSkewness(returns, lookback);
        const avgReturns = buildRollingAverage(returns, lookback);

        return createSignalLoop(cleanData, [skewness, avgReturns], (i) => {
            const skew = skewness[i];
            const ar = avgReturns[i];

            if (skew === null || ar === null) return null;

            // Buy: Skewness is positive & above threshold, and average return is positive (bullish asymmetry)
            if (skew > skewThreshold && ar > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish asymmetry: return skewness ${skew.toFixed(2)} > ${skewThreshold} with positive average return (${(ar * 100).toFixed(4)}%)`
                );
            }

            // Sell: Skewness is negative & below minus threshold, and average return is negative (bearish asymmetry)
            if (skew < -skewThreshold && ar < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish asymmetry: return skewness ${skew.toFixed(2)} < -${skewThreshold} with negative average return (${(ar * 100).toFixed(4)}%)`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
