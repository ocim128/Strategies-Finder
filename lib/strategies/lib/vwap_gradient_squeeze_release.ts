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
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        compressionLimit: Number(params.compressionLimit ?? 0.35),
    };
}

export const vwap_gradient_squeeze_release: Strategy = {
    name: "VWAP Gradient Squeeze Release",
    description: "Breakout from compression around the VWAP center, confirmed by expanding true range percentiles and positive/negative close location gradient.",
    defaultParams: {
        lookback: 30,
        compressionLimit: 0.35,
    },
    paramLabels: {
        lookback: "Lookback Window",
        compressionLimit: "Compression Limit",
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
        const trPct = buildPercentileRank(trueRange, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, trPct, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const prevPct = trPct[i - 1];
            const currPct = trPct[i];
            const currentVwap = vwap[i];
            if (prevPct === null || currPct === null || currentVwap === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            // Buy: prior range percentile < compressionLimit, current range percentile > 0.7, price above VWAP, close location gradient positive
            if (prevPct < (p.compressionLimit as number) && currPct > 0.7 && close > currentVwap && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Grad Squeeze Release Buy: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: prior range percentile < compressionLimit, current range percentile > 0.7, price below VWAP, close location gradient negative
            if (prevPct < (p.compressionLimit as number) && currPct > 0.7 && close < currentVwap && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Grad Squeeze Release Sell: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compressionLimit"],
    },
};
