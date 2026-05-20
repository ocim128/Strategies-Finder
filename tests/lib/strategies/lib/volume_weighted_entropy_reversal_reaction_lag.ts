import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { calculateEMA } from "../indicators";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildVolumeWeightedEntropy } from "./polymarket-1s-strategy-utils";

function normalizeVolumeWeightedEntropyReversalReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 3),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 1.35, 0),
        minLag: normalizeNumberParam(params.minLag, 0.015, 0),
    };
}

export const volume_weighted_entropy_reversal_reaction_lag: Strategy = {
    name: "Volume Weighted Entropy Reversal Reaction Lag",
    description: "Fades high-disorder Binance price-volume states after an EMA reclaim when Polymarket reaction lag confirms underreaction.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 1.35,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Entropy Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams: normalizeVolumeWeightedEntropyReversalReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeWeightedEntropyReversalReactionLagParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);
        const volumes = getVolumes(cleanData);
        const entropy = buildVolumeWeightedEntropy(typical, volumes, lookback);
        const ema = calculateEMA(closes, Math.max(2, Math.round(lookback / 2)));
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [entropy, ema, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < lookback + 1 || (entropy[i] ?? -Infinity) <= p.entropyThreshold) return null;
            const currentEma = ema[i];
            const previousEma = ema[i - 1];
            if (currentEma === null || previousEma === null) return null;

            const crossedAbove = closes[i - 1] <= previousEma && closes[i] > currentEma;
            if (crossedAbove && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Volume-weighted entropy reversal with long reaction lag");
            }

            const crossedBelow = closes[i - 1] >= previousEma && closes[i] < currentEma;
            if (crossedBelow && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Volume-weighted entropy reversal with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold", "minLag"],
    },
};
