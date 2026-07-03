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
    buildRollingAutoCorrelation,
} from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 60))),
        volThresholdMax: Number(params.volThresholdMax ?? 0.4),
    };
}

export const mean_reversion_volatility_median_alignment: Strategy = {
    name: "Mean Reversion Volatility Median Alignment",
    description: "Fades deviations from the rolling median in low-volatility regimes when autocorrelation is negative.",
    defaultParams: {
        lookback: 60,
        volThresholdMax: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThresholdMax: "Max Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [ac, volPct, median], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentVolPct = volPct[i];
            const currentMedian = median[i];
            if (currentAc === null || currentVolPct === null || currentMedian === null) return null;

            const close = closes[i];
            const maxVol = p.volThresholdMax as number;

            // Buy: vol percentile < volThresholdMax, autocorrelation < -0.2, close < median
            if (currentVolPct < maxVol && currentAc < -0.2 && close < currentMedian) {
                return createBuySignal(cleanData, i, `MR Vol Median Buy: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }
            // Sell: vol percentile < volThresholdMax, autocorrelation < -0.2, close > median
            if (currentVolPct < maxVol && currentAc < -0.2 && close > currentMedian) {
                return createSellSignal(cleanData, i, `MR Vol Median Sell: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThresholdMax"],
    },
};
