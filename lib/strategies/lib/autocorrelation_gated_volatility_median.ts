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
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 63))),
        volThreshold: Number(params.volThreshold ?? 0.7),
    };
}

export const autocorrelation_gated_volatility_median: Strategy = {
    name: "Autocorrelation Gated Volatility Median",
    description: "Enters in the direction of the rolling median in a high-volatility regime only when return autocorrelation confirms persistence.",
    defaultParams: {
        lookback: 63,
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

        return createSignalLoop(cleanData, [ac, volPct, median], (i) => {
            if (i < lookback) return null;
            const currentAc = ac[i];
            const currentVolPct = volPct[i];
            const currentMedian = median[i];
            if (currentAc === null || currentVolPct === null || currentMedian === null) return null;

            const close = closes[i];
            const volThresh = p.volThreshold as number;

            // Buy: vol percentile > volThreshold, autocorrelation > 0.2, close > median
            if (currentVolPct > volThresh && currentAc > 0.2 && close > currentMedian) {
                return createBuySignal(cleanData, i, `AutoGated Vol Med Buy: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }
            // Sell: vol percentile > volThreshold, autocorrelation > 0.2, close < median
            if (currentVolPct > volThresh && currentAc > 0.2 && close < currentMedian) {
                return createSellSignal(cleanData, i, `AutoGated Vol Med Sell: VolPct ${currentVolPct.toFixed(2)}, AC ${currentAc.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
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
