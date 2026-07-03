import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildPercentileRank } from "./price-action-statistics-core";
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minPercentile: Number(params.minPercentile ?? 0.7),
    };
}

export const typical_close_pressure_follow: Strategy = {
    name: "Typical Close Pressure Follow",
    description: "Follows closing momentum relative to average bar transaction price when true range expands.",
    defaultParams: {
        lookback: 30,
        minPercentile: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minPercentile: "Min Range Percentile",
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
        const typical = getTypicalPrices(cleanData);

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trPct = buildPercentileRank(trueRange, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);

        return createSignalLoop(cleanData, [trPct, atr], (i) => {
            if (i < lookback) return null;
            const currentTrPct = trPct[i];
            const currentAtr = atr[i];
            if (currentTrPct === null || currentAtr === null || currentAtr <= 0) return null;

            const close = closes[i];
            const typ = typical[i];
            const minPct = p.minPercentile as number;

            // Buy: range percentile > minPercentile, close - typical > 0.5 * ATR
            if (currentTrPct > minPct && close - typ > 0.5 * currentAtr) {
                return createBuySignal(cleanData, i, `Typical Close Pressure Buy: TrPct ${currentTrPct.toFixed(2)}, Diff ${(close - typ).toFixed(4)}`);
            }
            // Sell: range percentile > minPercentile, close - typical < -0.5 * ATR
            if (currentTrPct > minPct && close - typ < -0.5 * currentAtr) {
                return createSellSignal(cleanData, i, `Typical Close Pressure Sell: TrPct ${currentTrPct.toFixed(2)}, Diff ${(close - typ).toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minPercentile"],
    },
};
