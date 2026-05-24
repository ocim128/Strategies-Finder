import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeTailVolatilityDislocationExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        atrMultiplier: normalizeNumberParam(params.atrMultiplier, 2.2, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const tail_volatility_dislocation_executable_edge: Strategy = {
    name: "Tail Volatility Dislocation with Executable Edge",
    description: "Trades ATR tail dislocations only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        atrMultiplier: 2.2,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        atrMultiplier: "ATR Multiplier",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeTailVolatilityDislocationExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTailVolatilityDislocationExecutableEdgeParams(params);
        const lookback = p.lookback;
        const slowLookback = lookback * 3;
        if (cleanData.length < slowLookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typicals, lookback);
        const fastAtr = calculateATR(highs, lows, closes, lookback);
        const slowAtr = calculateATR(highs, lows, closes, slowLookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [median, fastAtr, slowAtr], (i) => {
            const center = median[i];
            const fast = fastAtr[i];
            const slow = slowAtr[i];
            if (center === null || fast === null || slow === null || slow <= 0 || fast / slow < 1.5) return null;

            if (
                typicals[i] > center + p.atrMultiplier * fast
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Upper ATR tail dislocation with executable YES edge");
            }
            if (
                typicals[i] < center - p.atrMultiplier * fast
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Lower ATR tail dislocation with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMultiplier", "minEdge"],
    },
};
