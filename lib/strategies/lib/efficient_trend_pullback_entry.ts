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
import { calculateATR } from "../indicators";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

const EFFICIENCY_LEVEL = 0.5;
const PULLBACK_TOLERANCE_ATR = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(15, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficient_trend_pullback_entry: Strategy = {
    name: "Efficient Trend Pullback Entry",
    description: "Buys pullbacks that bring price back within half an ATR of the rolling median, only inside efficient trends.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Trend Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        return createSignalLoop(cleanData, [efficiency, median, atr], (i) => {
            const eff = efficiency[i];
            const med = median[i];
            const atrNow = atr[i];
            if (eff === null || med === null || atrNow === null || atrNow <= 0) return null;

            const distance = (closes[i] - med) / atrNow;

            // Efficient up trend, price pulled back to the center: buy the continuation.
            if (eff >= EFFICIENCY_LEVEL && closes[i] > med && distance <= PULLBACK_TOLERANCE_ATR) {
                return createBuySignal(cleanData, i, `Efficient pullback buy: ER ${eff.toFixed(2)}, ${distance.toFixed(2)} ATR from center`);
            }
            if (eff >= EFFICIENCY_LEVEL && closes[i] < med && -distance <= PULLBACK_TOLERANCE_ATR) {
                return createSellSignal(cleanData, i, `Efficient pullback sell: ER ${eff.toFixed(2)}, ${(-distance).toFixed(2)} ATR from center`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
