import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { nullsToZero } from "./polymarket-1s-strategy-utils";

function normalizeCloseAcceptanceDecayExecutablePersistenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 3),
        decayFactor: normalizeNumberParam(params.decayFactor, 0.85, 0.01, 0.999),
        persistenceSec: normalizeIntegerParam(params.persistenceSec, 3, 1),
    };
}

export const close_acceptance_decay_executable_persistence: Strategy = {
    name: "Close Acceptance Decay Executable Persistence",
    description: "Requires persistent Binance close acceptance and a multi-second executable Polymarket edge before entering.",
    defaultParams: {
        lookback: 20,
        decayFactor: 0.85,
        persistenceSec: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        decayFactor: "Decay Factor",
        persistenceSec: "Persistence Seconds",
    },
    normalizeParams: normalizeCloseAcceptanceDecayExecutablePersistenceParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceDecayExecutablePersistenceParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const smoothedAcceptance = buildRollingAverage(acceptance, lookback);
        const decayedAcceptance = buildCumulativeDecaySum(nullsToZero(smoothedAcceptance), p.decayFactor);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];
        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0,
            ewmaLookback: p.persistenceSec,
        });

        return createSignalLoop(cleanData, [smoothedAcceptance], (i) => {
            if (i < lookback) return null;
            if (
                decayedAcceptance[i] > 2
                && actionability.yesActionable[i]
                && persistence.yesEdgeSeconds[i] >= p.persistenceSec
                && (edge.buyYesEdge[i] ?? -Infinity) > 0
            ) {
                return createBuySignal(cleanData, i, "Close acceptance decay with persistent YES edge");
            }
            if (
                decayedAcceptance[i] < -2
                && actionability.noActionable[i]
                && persistence.noEdgeSeconds[i] >= p.persistenceSec
                && (edge.buyNoEdge[i] ?? -Infinity) > 0
            ) {
                return createSellSignal(cleanData, i, "Close acceptance decay with persistent NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor", "persistenceSec"],
    },
};
