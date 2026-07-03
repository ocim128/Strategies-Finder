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
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        skewThreshold: Number(params.skewThreshold ?? 0.2),
    };
}

export const vwap_skew_acceptance_gradient: Strategy = {
    name: "VWAP Skew Acceptance Gradient",
    description: "Aligns structural true range skewness with price position relative to VWAP and close location gradient.",
    defaultParams: {
        lookback: 30,
        skewThreshold: 0.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewThreshold: "Skew Threshold",
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
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const skewness = buildRollingSkewness(trueRange, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, skewness, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentSkew = skewness[i];
            if (currentVwap === null || currentSkew === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const threshold = p.skewThreshold as number;

            // Buy: True range skewness > skewThreshold, price above VWAP, close location gradient positive
            if (currentSkew > threshold && close > currentVwap && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Skew Accept Buy: Skew ${currentSkew.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: True range skewness < -skewThreshold, price below VWAP, close location gradient negative
            if (currentSkew < -threshold && close < currentVwap && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Skew Accept Sell: Skew ${currentSkew.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
