import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zscoreThreshold: Math.max(0.01, Number(params.zscoreThreshold ?? 1.8)),
    };
}

export const median_distance_bar_rejection: Strategy = {
    name: "Median Distance Bar Rejection",
    description: "Fades ratio extensions from the rolling median z-score when a same-bar rejection confirms reversion.",
    defaultParams: {
        lookback: 30,
        zscoreThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zscoreThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const devs = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            devs[i] = m !== null ? closes[i] - m : 0;
        }

        const devZ = buildRollingZScore(devs, lookback);

        return createSignalLoop(cleanData, [median, devZ], (i) => {
            const z = devZ[i];
            const m = median[i];
            if (z === null || m === null) return null;

            const close = closes[i];
            const open = cleanData[i].open;

            // Buy: Z-score is extremely negative and current bar is rejecting downward (close > open)
            if (z < -p.zscoreThreshold && close > open) {
                return createBuySignal(cleanData, i, `Median distance rejection buy: Z-score ${z.toFixed(2)}`);
            }
            // Sell: Z-score is extremely positive and current bar is rejecting upward (close < open)
            if (z > p.zscoreThreshold && close < open) {
                return createSellSignal(cleanData, i, `Median distance rejection sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zscoreThreshold"],
    },
};
