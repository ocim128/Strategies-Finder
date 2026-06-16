import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingSkewness,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        pctlExtreme: Math.max(0.5, Math.min(1.0, Number(params.pctlExtreme ?? 0.90))),
    };
}

export const returns_skewness_percentile_reversion: Strategy = {
    name: "Returns Skewness Percentile Reversion",
    description: "Fades return distribution asymmetries using percentile-ranked rolling returns skewness.",
    defaultParams: {
        lookback: 30,
        pctlExtreme: 0.90,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skew = buildRollingSkewness(returns, lookback);
        const skewNumbers: number[] = skew.map((v) => (v !== null ? v : 0));
        const percentile = buildPercentileRank(skewNumbers, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            // Buy: return distribution overloaded to the downside (very low skew percentile)
            if (pRank < (1 - p.pctlExtreme)) {
                return createBuySignal(cleanData, i, `Skewness buy: percentile rank ${pRank.toFixed(2)}`);
            }
            // Sell: return distribution overloaded to the upside (very high skew percentile)
            if (pRank > p.pctlExtreme) {
                return createSellSignal(cleanData, i, `Skewness sell: percentile rank ${pRank.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
