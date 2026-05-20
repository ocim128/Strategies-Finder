import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMicroEfficiencyRegimeActionableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        efficiencyLookback: normalizeIntegerParam(params.efficiencyLookback, 10, 2),
        minEfficiency: normalizeNumberParam(params.minEfficiency, 0.60, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.01, 0),
    };
}

export const micro_efficiency_regime_actionable_edge: Strategy = {
    name: "Micro Efficiency Regime Actionable Edge",
    description: "Trades high-efficiency Binance micro-trends only when Polymarket executable quotes are actionable and underpriced.",
    defaultParams: {
        efficiencyLookback: 10,
        minEfficiency: 0.60,
        minEdge: 0.01,
    },
    paramLabels: {
        efficiencyLookback: "Efficiency Lookback",
        minEfficiency: "Minimum Efficiency Ratio",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeMicroEfficiencyRegimeActionableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroEfficiencyRegimeActionableEdgeParams(params);
        const lookback = p.efficiencyLookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [efficiency], (i) => {
            if (i < lookback || (efficiency[i] ?? -Infinity) <= p.minEfficiency) return null;

            if (
                closes[i] > closes[i - lookback]
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Micro efficiency uptrend with executable YES edge");
            }
            if (
                closes[i] < closes[i - lookback]
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Micro efficiency downtrend with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["efficiencyLookback", "minEfficiency", "minEdge"],
    },
};
