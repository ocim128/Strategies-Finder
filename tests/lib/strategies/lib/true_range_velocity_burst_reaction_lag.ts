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

function normalizeTrueRangeVelocityBurstReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 3),
        threshold: normalizeNumberParam(params.threshold, 2.0, 0),
        minLag: normalizeNumberParam(params.minLag, 0.01, 0),
    };
}

export const true_range_velocity_burst_reaction_lag: Strategy = {
    name: "True Range Volatility Burst Reaction Lag",
    description: "Enters high-speed Binance true-range expansions only when Polymarket reaction lag confirms underreaction.",
    defaultParams: {
        lookback: 30,
        threshold: 2.0,
        minLag: 0.01,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "True Range Z Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams: normalizeTrueRangeVelocityBurstReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTrueRangeVelocityBurstReactionLagParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const rangeZ = buildRollingZScore(trueRange, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [rangeZ, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < lookback) return null;
            if ((rangeZ[i] ?? -Infinity) <= p.threshold) return null;

            if (cleanData[i].close > cleanData[i].open && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "True range burst with long reaction lag");
            }
            if (cleanData[i].close < cleanData[i].open && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "True range burst with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold", "minLag"],
    },
};
