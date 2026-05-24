import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMicroCloseAcceptanceExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minAcceptance: normalizeNumberParam(params.minAcceptance, 0.75, 0.5, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const micro_close_acceptance_executable_edge: Strategy = {
    name: "Micro Close Acceptance with Executable Edge",
    description: "Trades directional close acceptance only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        minAcceptance: 0.75,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        minAcceptance: "Minimum Acceptance",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeMicroCloseAcceptanceExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroCloseAcceptanceExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const acceptanceAverage = buildRollingAverage(buildCloseAcceptanceSeries(cleanData), lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [acceptanceAverage], (i) => {
            const acceptance = acceptanceAverage[i];
            if (acceptance === null) return null;

            const directionalRatio = (acceptance + 1) / 2;
            if (
                directionalRatio >= p.minAcceptance
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Bullish close acceptance with executable YES edge");
            }
            if (
                directionalRatio <= 1 - p.minAcceptance
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Bearish close acceptance with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAcceptance", "minEdge"],
    },
};
