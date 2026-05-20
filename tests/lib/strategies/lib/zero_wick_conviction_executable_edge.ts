import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        maxOpposingWickPct: Math.max(0.001, Math.min(0.5, Number(params.maxOpposingWickPct ?? 0.05))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const zero_wick_conviction_executable_edge: Strategy = {
    name: "Zero Wick Conviction Executable Edge",
    description: "Enters high-conviction breakout bars on Binance where the opposing wick is non-existent (zero-wick candle), indicating absolute buyer/seller dominance, utilizing an executable edge to secure premium pricing.",
    defaultParams: {
        lookback: 15,
        maxOpposingWickPct: 0.05,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Wick Lookback",
        maxOpposingWickPct: "Max Opposing Wick %",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const maxOpposingWickPct = p.maxOpposingWickPct as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const bar = cleanData[i];
            const metrics = computePriceActionBarMetrics(bar);

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (buyYesEdge === null || buyNoEdge === null || metrics.range <= 0) return null;

            // Buy: close > open (bullish) and lower wick (opposing) is near-zero
            if (
                bar.close > bar.open &&
                metrics.lowerWick / metrics.range <= maxOpposingWickPct &&
                actionability.yesActionable[i] &&
                buyYesEdge >= minEdge
            ) {
                return createBuySignal(cleanData, i, `Bullish zero lower-wick breakout with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: close < open (bearish) and upper wick (opposing) is near-zero
            if (
                bar.close < bar.open &&
                metrics.upperWick / metrics.range <= maxOpposingWickPct &&
                actionability.noActionable[i] &&
                buyNoEdge >= minEdge
            ) {
                return createSellSignal(cleanData, i, `Bearish zero upper-wick breakout with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxOpposingWickPct", "minEdge"],
    },
};
