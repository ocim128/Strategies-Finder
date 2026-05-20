import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rocLookback: Math.max(1, Math.round(Number(params.rocLookback ?? 15))),
        percentileWindow: Math.max(5, Math.round(Number(params.percentileWindow ?? 100))),
        minLag: Math.max(0, Number(params.minLag ?? 0.015)),
    };
}

export const velocity_roc_percentile_reaction_lag: Strategy = {
    name: "Velocity ROC Percentile Reaction Lag",
    description: "Funnels capital into rapid velocity-breakout impulses on Binance, filtering for instances where the Polymarket CLOB shows a clear reaction lag to the sudden probability shift.",
    defaultParams: {
        rocLookback: 15,
        percentileWindow: 100,
        minLag: 0.015,
    },
    paramLabels: {
        rocLookback: "ROC Lookback",
        percentileWindow: "Percentile Window",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const rocLookback = p.rocLookback as number;
        const percentileWindow = p.percentileWindow as number;
        const minLag = p.minLag as number;

        if (cleanData.length < rocLookback + percentileWindow) return [];

        // Compute return series and its rate of change
        const closes = cleanData.map((bar) => bar.close);
        const roc = buildRateOfChange(closes, rocLookback);

        // Filter out nulls from roc to pass to buildPercentileRank
        const nonNullRoc = roc.map((v) => v ?? 0);
        const rank = buildPercentileRank(nonNullRoc, percentileWindow);

        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: rocLookback, lagSec: 3 });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [rank, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const currentRank = rank[i];
            const longLag = reaction.longLagEdge[i];
            const shortLag = reaction.shortLagEdge[i];

            if (currentRank === null || longLag === null || shortLag === null) return null;

            // Buy: ROC percentile rank > 0.90, underpriced bullish impulse
            if (currentRank > 0.90 && longLag >= minLag) {
                return createBuySignal(cleanData, i, `Bullish ROC percentile ${currentRank.toFixed(2)} with lag edge ${longLag.toFixed(3)}`);
            }

            // Sell: ROC percentile rank < 0.10, underpriced bearish impulse
            if (currentRank < 0.10 && shortLag >= minLag) {
                return createSellSignal(cleanData, i, `Bearish ROC percentile ${currentRank.toFixed(2)} with lag edge ${shortLag.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rocLookback", "percentileWindow", "minLag"],
    },
};
