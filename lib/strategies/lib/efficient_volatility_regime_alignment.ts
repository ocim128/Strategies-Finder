import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingMedian,
    buildRollingStdDev,
    buildPercentileRank,
    buildEfficiencyRatio,
} from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 55))),
        minEfficiency: Number(params.minEfficiency ?? 0.6),
    };
}

export const efficient_volatility_regime_alignment: Strategy = {
    name: "Efficient Volatility Regime Alignment",
    description: "Aligns entries with the rolling median in high-volatility regimes only when Kaufman Efficiency Ratio is elevated.",
    defaultParams: {
        lookback: 55,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);

        const er = buildEfficiencyRatio(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [volPct, er, median], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            const currentEr = er[i];
            const currentMedian = median[i];
            if (currentVolPct === null || currentEr === null || currentMedian === null) return null;

            const close = closes[i];
            const minEff = p.minEfficiency as number;

            // Buy: vol percentile > 0.6, efficiency > minEfficiency, close > median
            if (currentVolPct > 0.6 && currentEr > minEff && close > currentMedian) {
                return createBuySignal(cleanData, i, `Eff Vol Median Buy: VolPct ${currentVolPct.toFixed(2)}, ER ${currentEr.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }
            // Sell: vol percentile > 0.6, efficiency > minEfficiency, close < median
            if (currentVolPct > 0.6 && currentEr > minEff && close < currentMedian) {
                return createSellSignal(cleanData, i, `Eff Vol Median Sell: VolPct ${currentVolPct.toFixed(2)}, ER ${currentEr.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
