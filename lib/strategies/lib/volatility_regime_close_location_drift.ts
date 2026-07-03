import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingStdDev,
    buildPercentileRank,
} from "./price-action-statistics-core";
import { buildCloseLocationSeries, buildRollingAverage, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        minDev: Number(params.minDev ?? 0.1),
    };
}

export const volatility_regime_close_location_drift: Strategy = {
    name: "Volatility Regime Close Location Drift",
    description: "Follows smoothed close location drift in high-volatility regimes.",
    defaultParams: {
        lookback: 50,
        minDev: 0.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minDev: "Min Deviation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);

        const closeLoc = buildCloseLocationSeries(cleanData);
        const smoothedLoc = buildRollingAverage(closeLoc, lookback);

        return createSignalLoop(cleanData, [volPct, smoothedLoc], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            const currentSmoothLoc = smoothedLoc[i];
            if (currentVolPct === null || currentSmoothLoc === null) return null;

            const dev = p.minDev as number;

            // Buy: vol percentile > 0.6, smoothed close location > 0.5 + minDev
            if (currentVolPct > 0.6 && currentSmoothLoc > 0.5 + dev) {
                return createBuySignal(cleanData, i, `Vol Close Loc Drift Buy: VolPct ${currentVolPct.toFixed(2)}, SmoothLoc ${currentSmoothLoc.toFixed(4)}`);
            }
            // Sell: vol percentile > 0.6, smoothed close location < 0.5 - minDev
            if (currentVolPct > 0.6 && currentSmoothLoc < 0.5 - dev) {
                return createSellSignal(cleanData, i, `Vol Close Loc Drift Sell: VolPct ${currentVolPct.toFixed(2)}, SmoothLoc ${currentSmoothLoc.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minDev"],
    },
};
