import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
        threshold: Math.max(0, Math.min(1, Number(params.threshold ?? 0.95))),
    };
}

export const median_deviation_percentile_reversion: Strategy = {
    name: "Median Deviation Percentile Reversion",
    description: "Fades extreme deviations from the rolling median using percentile rank and close location agreement.",
    defaultParams: {
        lookback: 40,
        threshold: 0.95,
    },
    paramLabels: {
        lookback: "Lookback Window",
        threshold: "Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        const diffs: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            diffs[i] = m !== null ? Math.abs(closes[i] - m) : 0;
        }

        const percentile = buildPercentileRank(diffs, lookback);

        return createSignalLoop(cleanData, [median, percentile], (i) => {
            const m = median[i];
            const pRank = percentile[i];
            if (m === null || pRank === null) return null;

            const close = closes[i];
            const cl = closeLocation[i];

            if (close < m && pRank > p.threshold && cl > 0.5) {
                return createBuySignal(cleanData, i, `Close < Median with Dev Percentile ${pRank.toFixed(2)} and CL ${cl.toFixed(2)}`);
            }
            if (close > m && pRank > p.threshold && cl < 0.5) {
                return createSellSignal(cleanData, i, `Close > Median with Dev Percentile ${pRank.toFixed(2)} and CL ${cl.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
