import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import {
    buildRollingMedian,
    buildRollingStdDev,
    buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        volThreshold: Number(params.volThreshold ?? 0.7),
    };
}

export const typical_volatility_regime_median_divergence: Strategy = {
    name: "Typical Volatility Regime Median Divergence",
    description: "Fades price deviations from typical price median in high-volatility regimes.",
    defaultParams: {
        lookback: 50,
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
        const typical = getTypicalPrices(cleanData);

        const vol = buildRollingStdDev(typical, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);

        const medianTypical = buildRollingMedian(typical, lookback);

        return createSignalLoop(cleanData, [volPct, medianTypical], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            const currentMedian = medianTypical[i];
            if (currentVolPct === null || currentMedian === null) return null;

            const close = closes[i];
            const typ = typical[i];
            const volThresh = p.volThreshold as number;

            // Buy: vol percentile > volThreshold, close < median of typical, and close < typical
            if (currentVolPct > volThresh && close < currentMedian && close < typ) {
                return createBuySignal(cleanData, i, `Typical Vol Median Div Buy: VolPct ${currentVolPct.toFixed(2)}, Med ${currentMedian.toFixed(4)}, Typ ${typ.toFixed(4)}`);
            }
            // Sell: vol percentile > volThreshold, close > median of typical, and close > typical
            if (currentVolPct > volThresh && close > currentMedian && close > typ) {
                return createSellSignal(cleanData, i, `Typical Vol Median Div Sell: VolPct ${currentVolPct.toFixed(2)}, Med ${currentMedian.toFixed(4)}, Typ ${typ.toFixed(4)}`);
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
