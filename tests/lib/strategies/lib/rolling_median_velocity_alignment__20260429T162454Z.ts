import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRollingMedianVelocityAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 55))),
        velocity_lookback: Math.max(1, Math.round(Number(params.velocity_lookback ?? 10))),
    };
}

export const rolling_median_velocity_alignment: Strategy = {
    name: "Rolling Median Velocity Alignment",
    description:
        "Requires the daily close to align with a trailing median that is itself migrating in the same direction, filtering out flat centerlines.",
    defaultParams: {
        median_lookback: 55,
        velocity_lookback: 10,
    },
    paramLabels: {
        median_lookback: "Median Lookback",
        velocity_lookback: "Velocity Lookback",
    },
    normalizeParams: normalizeRollingMedianVelocityAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingMedianVelocityAlignmentParams(params);
        const medianLookback = p.median_lookback as number;
        const velocityLookback = p.velocity_lookback as number;
        if (cleanData.length < medianLookback + velocityLookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, medianLookback);

        return createSignalLoop(cleanData, [median], (i) => {
            const currentMedian = median[i];
            const priorMedian = median[i - velocityLookback];
            if (currentMedian === null || priorMedian === null) return null;

            if (closes[i] > currentMedian && currentMedian > priorMedian) {
                return createBuySignal(cleanData, i, "Close above rising rolling median");
            }
            if (closes[i] < currentMedian && currentMedian < priorMedian) {
                return createSellSignal(cleanData, i, "Close below falling rolling median");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["median_lookback", "velocity_lookback"],
    },
};
