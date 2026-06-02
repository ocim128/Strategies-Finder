import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    checkCrossover,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingStdDev, buildRollingMedian } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming close location standard deviation is high when closing prints are exhausted.
// #SUGGEST_VERIFY: Verify stdDevThreshold matches close location bounds [0, 1].
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        stdDevThreshold: Math.max(0.01, Number(params.stdDevThreshold ?? 0.25)),
    };
}

export const close_location_variance_exhaustion_fade: Strategy = {
    name: "Close Location Variance Exhaustion Fade",
    description: "Fades closing print variance spikes when price crosses back over the rolling median.",
    defaultParams: {
        lookback: 30,
        stdDevThreshold: 0.25,
    },
    paramLabels: {
        lookback: "Lookback",
        stdDevThreshold: "StdDev Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const stdDevThreshold = p.stdDevThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);
        const stdDev = buildRollingStdDev(closeLocation, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [stdDev, median], (i) => {
            const sd = stdDev[i];
            const m = median[i];
            if (sd === null || m === null) return null;

            if (sd > stdDevThreshold) {
                const cross = checkCrossover(closes, median, i);
                if (cross === "bullish") {
                    return createBuySignal(cleanData, i, `Close location stddev ${sd.toFixed(3)} > ${stdDevThreshold} with bullish crossover of median`);
                }
                if (cross === "bearish") {
                    return createSellSignal(cleanData, i, `Close location stddev ${sd.toFixed(3)} > ${stdDevThreshold} with bearish crossover of median`);
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "stdDevThreshold"],
    },
};
