import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMicroWickExhaustionExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        wickRatio: normalizeNumberParam(params.wickRatio, 0.65, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const micro_wick_exhaustion_executable_edge: Strategy = {
    name: "Micro Wick Exhaustion with Executable Edge",
    description: "Fades high-volume wick rejections at trailing extremes only when the matching Polymarket ask has executable edge.",
    defaultParams: {
        lookback: 20,
        wickRatio: 0.65,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        wickRatio: "Minimum Wick Ratio",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeMicroWickExhaustionExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroWickExhaustionExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const lowerWickRatio: number[] = new Array(cleanData.length).fill(0);
        const upperWickRatio: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const metrics = computePriceActionBarMetrics(cleanData[i]);
            if (metrics.range <= 0) continue;
            lowerWickRatio[i] = metrics.lowerWick / metrics.range;
            upperWickRatio[i] = metrics.upperWick / metrics.range;
        }

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, volumeZ], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const volScore = volumeZ[i];
            if (low === null || high === null || volScore === null || volScore <= 1) return null;

            if (
                typicals[i] <= low
                && lowerWickRatio[i] >= p.wickRatio
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Lower-wick exhaustion at range low with executable YES edge");
            }
            if (
                typicals[i] >= high
                && upperWickRatio[i] >= p.wickRatio
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Upper-wick exhaustion at range high with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "wickRatio", "minEdge"],
    },
};
