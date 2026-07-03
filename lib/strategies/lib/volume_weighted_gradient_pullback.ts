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
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        minVolPctl: Number(params.minVolPctl ?? 0.7),
    };
}

export const volume_weighted_gradient_pullback: Strategy = {
    name: "Volume-Weighted Gradient Pullback",
    description: "Buying trend pullbacks to the VWAP center under high volume, confirmed by close location gradient turning back to trend direction.",
    defaultParams: {
        lookback: 40,
        minVolPctl: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minVolPctl: "Min Volume Percentile",
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

        const vwapClean = vwap.map((v) => v ?? 0);
        const vwapRoc = buildRateOfChange(vwapClean, lookback);

        const volPct = buildPercentileRank(volumes, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, vwapRoc, volPct, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const currentRoc = vwapRoc[i];
            const currentVolPct = volPct[i];
            if (currentVwap === null || prevVwap === null || currentRoc === null || currentVolPct === null) return null;

            const low = lows[i];
            const high = highs[i];
            const closePrev = closes[i - 1];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            // Touches or crosses from above (low <= VWAP and prior close >= prior VWAP)
            const touchesFromAbove = low <= currentVwap && closePrev >= prevVwap;
            // Touches or crosses from below (high >= VWAP and prior close <= prior VWAP)
            const touchesFromBelow = high >= currentVwap && closePrev <= prevVwap;

            const minVol = p.minVolPctl as number;

            // Buy: touches/crosses from above, VWAP slope positive, volume percentile high, close location gradient positive
            if (touchesFromAbove && currentRoc > 0 && currentVolPct > minVol && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Pullback Buy: Low ${low.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, VolPct ${currentVolPct.toFixed(2)}`);
            }
            // Sell: touches/crosses from below, VWAP slope negative, volume percentile high, close location gradient negative
            if (touchesFromBelow && currentRoc < 0 && currentVolPct > minVol && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Pullback Sell: High ${high.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, VolPct ${currentVolPct.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minVolPctl"],
    },
};
