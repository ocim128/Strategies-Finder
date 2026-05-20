import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildLogReturnSeries, buildRollingKurtosis } from "./polymarket-1s-strategy-utils";

function normalizeRollingSkewnessKurtosisExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 4),
        kurtosisThreshold: normalizeNumberParam(params.kurtosisThreshold, 4.0, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.01, 0),
    };
}

export const rolling_skewness_kurtosis_executable_edge: Strategy = {
    name: "Rolling Skewness Kurtosis Executable Edge",
    description: "Fades fat-tailed Binance return skew snapbacks only when Polymarket offers an actionable executable edge.",
    defaultParams: {
        lookback: 35,
        kurtosisThreshold: 4.0,
        minEdge: 0.01,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosisThreshold: "Kurtosis Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeRollingSkewnessKurtosisExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeRollingSkewnessKurtosisExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const returns = buildLogReturnSeries(cleanData);
        const skewness = buildRollingSkewness(returns, lookback);
        const kurtosis = buildRollingKurtosis(returns, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [skewness, kurtosis], (i) => {
            if (i < lookback + 1 || (kurtosis[i] ?? -Infinity) <= p.kurtosisThreshold) return null;
            const previousSkew = skewness[i - 1];
            const currentSkew = skewness[i];
            if (previousSkew === null || currentSkew === null) return null;

            if (
                previousSkew <= -1.2
                && currentSkew > -1.2
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Downside skew snapback with executable YES edge");
            }
            if (
                previousSkew >= 1.2
                && currentSkew < 1.2
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Upside skew snapback with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisThreshold", "minEdge"],
    },
};
