import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMidpointDeviationNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        devThreshold: normalizeNumberParam(params.devThreshold, 1.5, 0),
    };
}

export const midpoint_deviation_no_adverse: Strategy = {
    name: "Midpoint Deviation with No Adverse Mask",
    description: "Trades volume-weighted close deviations from bar midpoint only when the Polymarket no-adverse mask allows the side.",
    defaultParams: {
        lookback: 20,
        devThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        devThreshold: "Deviation Z-Score Threshold",
    },
    normalizeParams: normalizeMidpointDeviationNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMidpointDeviationNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const weightedDeviation = cleanData.map((bar) => {
            const metrics = computePriceActionBarMetrics(bar);
            if (metrics.range <= 0) return 0;
            return ((bar.close - metrics.midpoint) / metrics.range) * Math.max(0, bar.volume);
        });
        const deviationZ = buildRollingZScore(weightedDeviation, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [deviationZ], (i) => {
            const z = deviationZ[i];
            if (z === null) return null;

            if (z >= p.devThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Volume-weighted midpoint deviation with no adverse YES mask");
            }
            if (z <= -p.devThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Volume-weighted midpoint deviation with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "devThreshold"],
    },
};
