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
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        minRangePercentile: Number(params.minRangePercentile ?? 0.7),
    };
}

export const vwap_volatility_gradient_alignment: Strategy = {
    name: "VWAP Volatility Gradient Alignment",
    description: "Enters in the direction of close location gradient aligned with price position relative to VWAP when volatility is expanding.",
    defaultParams: {
        lookback: 35,
        minRangePercentile: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minRangePercentile: "Min Range Percentile",
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
            const currentVwap = vwap[i];
            const currentPct = trPct[i];
            if (currentVwap === null || currentPct === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const minPct = p.minRangePercentile as number;

            // Buy: price is above VWAP, range percentile is high, close location gradient positive
            if (close > currentVwap && currentPct > minPct && currGrad > 0) {
                return createBuySignal(cleanData, i, `VWAP Vol Align Buy: Close ${close.toFixed(4)}, RangePct ${currentPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }
            // Sell: price is below VWAP, range percentile is high, close location gradient negative
            if (close < currentVwap && currentPct > minPct && currGrad < 0) {
                return createSellSignal(cleanData, i, `VWAP Vol Align Sell: Close ${close.toFixed(4)}, RangePct ${currentPct.toFixed(2)}, Grad ${currGrad.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minRangePercentile"],
    },
};
