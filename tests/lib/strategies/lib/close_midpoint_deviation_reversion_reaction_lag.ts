import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeCloseMidpointDeviationReversionReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 3),
        deviationThreshold: normalizeNumberParam(params.deviationThreshold, 1.8, 0),
        minLag: normalizeNumberParam(params.minLag, 0.015, 0),
    };
}

export const close_midpoint_deviation_reversion_reaction_lag: Strategy = {
    name: "Close Midpoint Deviation Reversion Reaction Lag",
    description: "Fades extreme close-midpoint deviations when Binance rejection starts reversing and Polymarket reaction lag confirms underreaction.",
    defaultParams: {
        lookback: 25,
        deviationThreshold: 1.8,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        deviationThreshold: "Deviation Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams: normalizeCloseMidpointDeviationReversionReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseMidpointDeviationReversionReactionLagParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const midpointDeviation = extractBarMetricSeries(cleanData, "closeMidpointDev");
        const deviationZ = buildRollingZScore(midpointDeviation, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [deviationZ, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < lookback + 1) return null;
            const z = deviationZ[i];
            if (z === null) return null;

            if (
                z < -p.deviationThreshold
                && midpointDeviation[i] > midpointDeviation[i - 1]
                && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag
            ) {
                return createBuySignal(cleanData, i, "Close-midpoint downside rejection with long reaction lag");
            }
            if (
                z > p.deviationThreshold
                && midpointDeviation[i] < midpointDeviation[i - 1]
                && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag
            ) {
                return createSellSignal(cleanData, i, "Close-midpoint upside rejection with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deviationThreshold", "minLag"],
    },
};
