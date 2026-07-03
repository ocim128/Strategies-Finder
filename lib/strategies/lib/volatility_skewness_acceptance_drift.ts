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
    buildRollingSkewness,
} from "./price-action-statistics-core";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        minSkew: Number(params.minSkew ?? 0.2),
    };
}

export const volatility_skewness_acceptance_drift: Strategy = {
    name: "Volatility Skewness Acceptance Drift",
    description: "Aligns return skewness with close acceptance in high-volatility expansions to capture persistent trends.",
    defaultParams: {
        lookback: 50,
        minSkew: 0.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minSkew: "Min Skew",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skewness = buildRollingSkewness(returns, lookback);
        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);
        const volPct = buildPercentileRank(volClean, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [skewness, volPct, acceptance], (i) => {
            if (i < lookback) return null;
            const currentSkew = skewness[i];
            const currentVolPct = volPct[i];
            const currentAccept = acceptance[i];
            if (currentSkew === null || currentVolPct === null || currentAccept === null) return null;

            const threshold = p.minSkew as number;

            // Buy: vol percentile > 0.6, skewness > minSkew, close acceptance > 0
            if (currentVolPct > 0.6 && currentSkew > threshold && currentAccept > 0) {
                return createBuySignal(cleanData, i, `Vol Skew Drift Buy: VolPct ${currentVolPct.toFixed(2)}, Skew ${currentSkew.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }
            // Sell: vol percentile > 0.6, skewness < -minSkew, close acceptance < 0
            if (currentVolPct > 0.6 && currentSkew < -threshold && currentAccept < 0) {
                return createSellSignal(cleanData, i, `Vol Skew Drift Sell: VolPct ${currentVolPct.toFixed(2)}, Skew ${currentSkew.toFixed(2)}, Accept ${currentAccept.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minSkew"],
    },
};
