import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    createSignalLoop,
    createBuySignal,
    createSellSignal
} from "../strategy-helpers";
import { calculateSMA, calculateATR } from "../indicators";
import { buildRangeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.max(2, Math.round(Number(params.period ?? 20))),
    };
}

export const whipsaw_crossing_burst_reversal: Strategy = {
    name: "Whipsaw Crossing Burst Reversal",
    description: "Whipsaw crossing across moving average with range expansion.",
    defaultParams: {
        "period": 20
    },
    paramLabels: {
        "period": "SMA Period"
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const period = p.period as number;
        if (cleanData.length < period + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const sma = calculateSMA(closes, period);
        const atr = calculateATR(highs, lows, closes, period);
        const ranges = buildRangeSeries(cleanData);

        return createSignalLoop(cleanData, [sma, atr], (i) => {
            const s = sma[i];
            const a = atr[i];
            if (s === null || a === null || a === 0) return null;

            const isCrossing = cleanData[i].low < s && cleanData[i].high > s;
            const isBurst = ranges[i] >= 1.15 * a;

            if (isCrossing && isBurst && cleanData[i].close > s) {
                return createSellSignal(cleanData, i, "Whipsaw crossing burst upward fade");
            }
            if (isCrossing && isBurst && cleanData[i].close < s) {
                return createBuySignal(cleanData, i, "Whipsaw crossing burst downward fade");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["period"]
    }
};
