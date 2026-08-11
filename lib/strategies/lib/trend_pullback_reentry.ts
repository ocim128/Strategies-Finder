import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingRobustZScore } from "./price-action-statistics-core";

const TREND_MEDIAN_WINDOW = 120;
const PULLBACK_Z_DEPTH = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const trend_pullback_reentry: Strategy = {
    name: "Trend Pullback Reentry",
    description: "Buys discounted dips inside an up ratio trend and sells premium rallies inside a down ratio trend.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Pullback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < TREND_MEDIAN_WINDOW) return [];

        const closes = getCloses(cleanData);
        const robustZ = buildRollingRobustZScore(closes, lookback);
        const trendMedian = buildRollingMedian(closes, TREND_MEDIAN_WINDOW);

        return createSignalLoop(cleanData, [robustZ], (i) => {
            if (i < TREND_MEDIAN_WINDOW) return null;
            const z = robustZ[i];
            const trend = trendMedian[i];
            if (z === null || trend === null) return null;

            // Discounted dip inside an up ratio trend.
            if (closes[i] > trend && z <= -PULLBACK_Z_DEPTH) {
                return createBuySignal(cleanData, i, `Trend pullback buy: z ${z.toFixed(2)} dip inside uptrend`);
            }
            // Premium rally inside a down ratio trend.
            if (closes[i] < trend && z >= PULLBACK_Z_DEPTH) {
                return createSellSignal(cleanData, i, `Trend pullback sell: z ${z.toFixed(2)} rally inside downtrend`);
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
