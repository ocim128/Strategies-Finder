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
import { buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minVolPctl: Number(params.minVolPctl ?? 0.7),
    };
}

export const volume_percentile_gated_vwap_cross: Strategy = {
    name: "Volume Percentile Gated VWAP Cross",
    description: "Crossovers of the rolling VWAP center are only traded when proxy volume is in a high percentile and the close location gradient agrees.",
    defaultParams: {
        lookback: 30,
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
        const volPct = buildPercentileRank(volumes, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, volPct, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const currentVolPct = volPct[i];
            if (currentVwap === null || prevVwap === null || currentVolPct === null) return null;

            const close = closes[i];
            const closePrev = closes[i - 1];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const crossAbove = closePrev <= prevVwap && close > currentVwap;
            const crossBelow = closePrev >= prevVwap && close < currentVwap;
            const minVol = p.minVolPctl as number;

            // Buy: price crosses above VWAP, volume percentile > minVolPctl, close location gradient positive
            if (crossAbove && currentVolPct > minVol && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Cross Above Gated: VolPct ${currentVolPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: price crosses below VWAP, volume percentile > minVolPctl, close location gradient negative
            if (crossBelow && currentVolPct > minVol && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Cross Below Gated: VolPct ${currentVolPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
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
