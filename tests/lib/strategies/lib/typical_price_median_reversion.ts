import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const typical_price_median_reversion: Strategy = {
    name: "Typical Price Median Reversion",
    description: "Fades typical price deviations from the rolling median.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typical, lookback);
        const stdDev = buildRollingStdDev(typical, lookback);

        return createSignalLoop(cleanData, [median, stdDev], (i) => {
            const m = median[i];
            const sd = stdDev[i];
            if (m === null || sd === null || sd <= 1e-9) return null;

            const tp = typical[i];
            const z = (tp - m) / sd;

            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Typical price median reversion buy: Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Typical price median reversion sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
