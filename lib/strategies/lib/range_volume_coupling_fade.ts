import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingCorrelation } from "./price-action-statistics-core";

const COUPLING_GATE = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const range_volume_coupling_fade: Strategy = {
    name: "Range Volume Coupling Fade",
    description: "Routes by the correlation of bar size with relative volume participation.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Coupling Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        // Volume enters only as a relative percentile proxy.
        const volumePct = buildPercentileRank(getVolumes(cleanData), lookback).map((v) => (v === null ? NaN : v));
        const coupling = buildRollingCorrelation(ranges, volumePct, lookback);

        return createSignalLoop(cleanData, [coupling], (i) => {
            const c = coupling[i];
            if (c === null || Number.isNaN(c)) return null;

            // Wide bars on shrinking relative volume are unanchored prints: fade them.
            if (c <= -COUPLING_GATE && cleanData[i].close < cleanData[i].open) {
                return createBuySignal(cleanData, i, `Weak-participation down print: coupling ${c.toFixed(2)}`);
            }
            // Wide bars with rising relative volume are participation-backed: continue.
            if (c >= COUPLING_GATE && cleanData[i].close > cleanData[i].open) {
                return createSellSignal(cleanData, i, `Participation-backed up print: coupling ${c.toFixed(2)}`);
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
