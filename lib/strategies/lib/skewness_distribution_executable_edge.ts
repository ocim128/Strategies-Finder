import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeSkewnessDistributionExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.2, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const skewness_distribution_executable_edge: Strategy = {
    name: "Skewness Distribution with Executable Edge",
    description: "Fades extreme rolling return skewness only when the matching Polymarket ask side is actionable and underpriced.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.2,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Skewness Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeSkewnessDistributionExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessDistributionExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const skewness = buildRollingSkewness(returns, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [skewness], (i) => {
            const skew = skewness[i];
            if (skew === null) return null;

            if (skew <= -p.skewThreshold && actionability.yesActionable[i] && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Negative return skewness with executable YES edge");
            }
            if (skew >= p.skewThreshold && actionability.noActionable[i] && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Positive return skewness with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "minEdge"],
    },
};
