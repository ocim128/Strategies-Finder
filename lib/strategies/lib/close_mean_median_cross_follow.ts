import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const close_mean_median_cross_follow: Strategy = {
    name: "Close Mean-Median Cross Follow",
    description: "Follows the direction of the close distribution's shape shift: mean crossing above the median signals strong closes reshaping the auction.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Distribution Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const mean = buildRollingAverage(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        // The loop guard guarantees both series are non-null at i and i-1, so
        // checkCrossover's internal assertions are safe.
        return createSignalLoop(cleanData, [mean, median], (i) => {
            const cross = checkCrossover(mean, median, i);
            if (cross === "bullish") {
                return createBuySignal(cleanData, i, `Mean-median buy: mean crossed above median (strong closes reshaping auction)`);
            }
            if (cross === "bearish") {
                return createSellSignal(cleanData, i, `Mean-median sell: mean crossed below median (weak closes reshaping auction)`);
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
