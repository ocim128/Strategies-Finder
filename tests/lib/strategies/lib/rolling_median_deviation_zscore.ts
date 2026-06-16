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
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const rolling_median_deviation_zscore: Strategy = {
    name: "Rolling Median Deviation Z-Score",
    description: "Fades ratio extensions based on the z-score of its deviation from the rolling median.",
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

            if (close < m && z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Rolling median dev buy: Z-score ${z.toFixed(2)}`);
            }
            if (close > m && z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Rolling median dev sell: Z-score ${z.toFixed(2)}`);
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
