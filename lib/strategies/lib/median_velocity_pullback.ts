import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

const VELOCITY_GATE = 0.005;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const median_velocity_pullback: Strategy = {
    name: "Median Velocity Pullback",
    description: "Buys dips into a rising rolling median and rallies into a falling one.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        // Fill warm-up nulls with the last available median so the crossover has a
        // dense series, but only evaluate once both velocity endpoints are real.
        const filledMedian = new Array<number>(cleanData.length).fill(0);
        let lastMedian: number | null = null;
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            if (m !== null) lastMedian = m;
            filledMedian[i] = lastMedian ?? closes[i];
        }

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback) return null;

            const currentMedian = median[i];
            const previousMedian = median[i - 1];
            if (currentMedian === null || previousMedian === null || previousMedian === 0) return null;

            const velocity = (currentMedian - previousMedian) / previousMedian;
            const cross = checkCrossover(closes, filledMedian, i);

            if (velocity > VELOCITY_GATE && cross === "bearish") {
                return createBuySignal(cleanData, i, `Pullback into rising median: drift ${(velocity * 100).toFixed(2)}%`);
            }
            if (velocity < -VELOCITY_GATE && cross === "bullish") {
                return createSellSignal(cleanData, i, `Rally into falling median: drift ${(velocity * 100).toFixed(2)}%`);
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
