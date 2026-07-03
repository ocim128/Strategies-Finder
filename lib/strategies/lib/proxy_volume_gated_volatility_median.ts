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
} from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 60))),
        volumeThreshold: Number(params.volumeThreshold ?? 0.7),
    };
}

export const proxy_volume_gated_volatility_median: Strategy = {
    name: "Proxy Volume Gated Volatility Median",
    description: "Trades volatility expansions aligned with rolling median only when proxy volume percentile confirms active leg participation.",
    defaultParams: {
        lookback: 60,
        volumeThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volumeThreshold: "Volume Percentile Threshold",
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

        const volumes = cleanData.map((d) => d.volume);
        const volPctRank = buildPercentileRank(volumes, lookback);

        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [volPct, volPctRank, median], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            const currentVolPctRank = volPctRank[i];
            const currentMedian = median[i];
            if (currentVolPct === null || currentVolPctRank === null || currentMedian === null) return null;

            const close = closes[i];
            const volThresh = p.volumeThreshold as number;

            // Buy: vol percentile > 0.6, volume percentile > volumeThreshold, close > median
            if (currentVolPct > 0.6 && currentVolPctRank > volThresh && close > currentMedian) {
                return createBuySignal(cleanData, i, `Proxy Vol Median Buy: VolPct ${currentVolPct.toFixed(2)}, VolPctRank ${currentVolPctRank.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }
            // Sell: vol percentile > 0.6, volume percentile > volumeThreshold, close < median
            if (currentVolPct > 0.6 && currentVolPctRank > volThresh && close < currentMedian) {
                return createSellSignal(cleanData, i, `Proxy Vol Median Sell: VolPct ${currentVolPct.toFixed(2)}, VolPctRank ${currentVolPctRank.toFixed(2)}, Med ${currentMedian.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volumeThreshold"],
    },
};
