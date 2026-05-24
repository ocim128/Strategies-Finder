import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const EXHAUSTION_THRESHOLD = 3.0;

function normalizeCumulativeInitiativeDecayExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        decay: normalizeNumberParam(params.decay, 0.82, 0.01, 0.999),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const cumulative_initiative_decay_executable_edge: Strategy = {
    name: "Cumulative Initiative Decay with Executable Edge",
    description: "Fades decayed initiative-pressure exhaustion only when the matching Polymarket ask has executable edge.",
    defaultParams: {
        lookback: 25,
        decay: 0.82,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Initiative Lookback",
        decay: "Decay Factor",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeCumulativeInitiativeDecayExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeInitiativeDecayExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const decayed = buildCumulativeDecaySum(initiative.map((value) => value ?? 0), p.decay);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback + 1) return null;
            const current = decayed[i];
            const previous = decayed[i - 1];

            if (
                current <= -EXHAUSTION_THRESHOLD
                && current > previous
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Bearish initiative exhaustion turning up with executable YES edge");
            }
            if (
                current >= EXHAUSTION_THRESHOLD
                && current < previous
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Bullish initiative exhaustion turning down with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay", "minEdge"],
    },
};
