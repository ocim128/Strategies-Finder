import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        maxRangePercentile: Math.max(0, Math.min(1, Number(params.maxRangePercentile ?? 0.40))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.5)),
    };
}

export const low_range_median_reversion: Strategy = {
    name: "Low Range Median Reversion",
    description: "Fades minor typical price z-score extensions when range percentile rank is low (tight leg coupling).",
    defaultParams: {
        lookback: 30,
        maxRangePercentile: 0.40,
        zThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxRangePercentile: "Max Range Percentile",
        zThreshold: "Typical Price Z-Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);

        const typical = getTypicalPrices(cleanData);
        const typicalZ = buildRollingZScore(typical, lookback);

        return createSignalLoop(cleanData, [rangePctl, typicalZ], (i) => {
            const rp = rangePctl[i];
            const z = typicalZ[i];
            if (rp === null || z === null) return null;

            if (rp < p.maxRangePercentile) {
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Low range median buy: Typical Z ${z.toFixed(2)}, range rank ${rp.toFixed(2)}`);
                }
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Low range median sell: Typical Z ${z.toFixed(2)}, range rank ${rp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxRangePercentile", "zThreshold"],
    },
};
