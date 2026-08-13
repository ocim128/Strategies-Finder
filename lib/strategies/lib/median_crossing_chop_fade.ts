import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian, buildThresholdCrossingCount } from "./price-action-statistics-core";

const CROSSING_FLOOR = 4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 24))),
    };
}

export const median_crossing_chop_fade: Strategy = {
    name: "Median Crossing Chop Fade",
    description: "Fades toward the rolling median when the close flips it often enough to signal chop.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Median / Crossing Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);

        const deviation = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            deviation[i] = m === null ? 0 : closes[i] - m;
        }
        const crossingCount = buildThresholdCrossingCount(deviation, lookback, 0);

        return createSignalLoop(cleanData, [median, crossingCount], (i) => {
            const m = median[i];
            const count = crossingCount[i];
            if (m === null || count === null) return null;

            if (count >= CROSSING_FLOOR && closes[i] < m) {
                return createBuySignal(cleanData, i, `Chop fade up: ${count} median crossings`);
            }
            if (count >= CROSSING_FLOOR && closes[i] > m) {
                return createSellSignal(cleanData, i, `Chop fade down: ${count} median crossings`);
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
