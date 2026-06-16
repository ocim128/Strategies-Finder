import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        rangePctlThreshold: Math.max(0, Math.min(1, Number(params.rangePctlThreshold ?? 0.25))),
    };
}

export const range_compression_coupling_break: Strategy = {
    name: "Range Compression Coupling Break",
    description: "Follows breakouts when the ratio breaks out of a multi-bar range compression phase.",
    defaultParams: {
        lookback: 20,
        rangePctlThreshold: 0.25,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangePctlThreshold: "Range Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);

        const closeLocation = buildCloseLocationSeries(cleanData);

        // Build flags array: 1 if range percentile is below threshold, 0 otherwise
        const flags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const rp = rangePercentile[i];
            flags[i] = rp !== null && rp < p.rangePctlThreshold ? 1 : 0;
        }

        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [rangePercentile, streaks], (i) => {
            if (i < 1) return null;

            const cl = closeLocation[i];
            const prevStreak = streaks[i - 1];

            // Trigger when previous range compression streak was >= 3 bars
            if (prevStreak >= 3) {
                if (cl > 0.7) {
                    return createBuySignal(cleanData, i, `Range compression break buy: prev streak ${prevStreak}, current CL ${cl.toFixed(2)}`);
                }
                if (cl < 0.3) {
                    return createSellSignal(cleanData, i, `Range compression break sell: prev streak ${prevStreak}, current CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePctlThreshold"],
    },
};
