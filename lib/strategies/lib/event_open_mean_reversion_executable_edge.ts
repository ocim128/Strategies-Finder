import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
    buildPolymarket1sPressureGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenMeanReversionExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        devThreshold: normalizeNumberParam(params.devThreshold, 2.0, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const event_open_mean_reversion_executable_edge: Strategy = {
    name: "Event Open Mean Reversion with Executable Edge",
    description: "Fades event-open distance extremes only when the contrarian Polymarket ask is actionable and underpriced.",
    defaultParams: {
        volLookback: 50,
        devThreshold: 2.0,
        minEdge: 0.02,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        devThreshold: "Distance Z-Score Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeEventOpenMeanReversionExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenMeanReversionExecutableEdgeParams(params);
        if (cleanData.length < p.volLookback + 2) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: p.volLookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: p.volLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [pressure.distanceZ], (i) => {
            const current = pressure.distanceZ[i];
            const previous = pressure.distanceZ[i - 1];
            if (current === null || previous === null) return null;

            if (
                previous <= -p.devThreshold
                && current > -p.devThreshold
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Event-open downside extreme reverted with executable YES edge");
            }
            if (
                previous >= p.devThreshold
                && current < p.devThreshold
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Event-open upside extreme reverted with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "devThreshold", "minEdge"],
    },
};
