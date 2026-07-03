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
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 45))),
        volThreshold: Number(params.volThreshold ?? 0.7),
    };
}

export const failed_volatility_expansion_fade: Strategy = {
    name: "Failed Volatility Expansion Fade",
    description: "Fades false volatility expansions when return autocorrelation is negative, close location is neutral, and price deviates from rolling median.",
    defaultParams: {
        lookback: 45,
        volThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThreshold: "Vol Percentile Threshold",
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
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [ac, volPct, median, closeLoc], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentVolPct = volPct[i];
            const currentMedian = median[i];
            const currentLoc = closeLoc[i];
            if (currentAc === null || currentVolPct === null || currentMedian === null || currentLoc === null) return null;

            const close = closes[i];
            const volThresh = p.volThreshold as number;

            // Buy: vol percentile > volThreshold, AC < -0.2, close location neutral (0.4 to 0.6), close < median
            if (currentVolPct > volThresh && currentAc < -0.2 && currentLoc >= 0.4 && currentLoc <= 0.6 && close < currentMedian) {
                return createBuySignal(cleanData, i, `Failed Vol Expansion Buy: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }
            // Sell: vol percentile > volThreshold, AC < -0.2, close location neutral (0.4 to 0.6), close > median
            if (currentVolPct > volThresh && currentAc < -0.2 && currentLoc >= 0.4 && currentLoc <= 0.6 && close > currentMedian) {
                return createSellSignal(cleanData, i, `Failed Vol Expansion Sell: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThreshold"],
    },
};
