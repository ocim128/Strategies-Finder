import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingSkewness } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        minSkew: Number(params.minSkew ?? 0.2),
    };
}

export const vwap_skew_gradient_exhaustion: Strategy = {
    name: "VWAP Skew Gradient Exhaustion",
    description: "Fades price deviations from the VWAP center when return skewness is extreme and close location gradient reverses.",
    defaultParams: {
        lookback: 40,
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

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = cleanData.map((d) => d.volume);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const skew = buildRollingSkewness(returns, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, skew, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentSkew = skew[i];
            if (currentVwap === null || currentSkew === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];
            const threshold = p.minSkew as number;

            // Buy: return skewness < -minSkew, price < VWAP, close location gradient positive
            if (currentSkew < -threshold && close < currentVwap && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Skew Exh Buy: Skew ${currentSkew.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: return skewness > minSkew, price > VWAP, close location gradient negative
            if (currentSkew > threshold && close > currentVwap && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Skew Exh Sell: Skew ${currentSkew.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
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
