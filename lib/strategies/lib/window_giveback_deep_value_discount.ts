import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 36))),
    };
}

export const window_giveback_deep_value_discount: Strategy = {
    name: "Window Giveback Deep Value Discount",
    description: "Buys value pullback discounts when excursion giveback reaches its rolling 95th percentile within an overarching macro trend.",
    defaultParams: {
        lookback: 36,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < Math.max(48, lookback) + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, 20);
        const gbValues = gb.map((v) => (v !== null ? v : NaN));
        const pctGb = buildPercentileRank(gbValues, lookback);

        return createSignalLoop(cleanData, [pctGb], (i) => {
            if (i < 48) return null;
            const pctl = pctGb[i];
            if (pctl === null || pctl < 0.95) return null;

            if (closes[i] > closes[i - 48] && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish deep value discount: giveback percentile ${pctl.toFixed(3)} >= 0.95, bull bar, macro uptrend (close > close[i-48])`);
            }
            if (closes[i] < closes[i - 48] && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish deep value discount: giveback percentile ${pctl.toFixed(3)} >= 0.95, bear bar, macro downtrend (close < close[i-48])`);
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
