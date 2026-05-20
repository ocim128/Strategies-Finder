import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { computePriceActionBarMetrics, buildRollingAverage } from "./price-action-frequency-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        minBodyPct: Math.max(0.1, Math.min(0.99, Number(params.minBodyPct ?? 0.80))),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 3))),
    };
}

export const body_percent_expansion_reaction_lag: Strategy = {
    name: "Body Percent Expansion Reaction Lag",
    description: "Enters strong directional breakout bars on Binance characterized by high body-to-range proportions, gating entries on a confirmed reaction lag on Polymarket.",
    defaultParams: {
        lookback: 20,
        minBodyPct: 0.80,
        lagSec: 3,
    },
    paramLabels: {
        lookback: "Range Avg Lookback",
        minBodyPct: "Minimum Body %",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minBodyPct = p.minBodyPct as number;
        const lagSec = p.lagSec as number;

        if (cleanData.length < lookback + 1) return [];

        // Build ranges and their rolling average
        const ranges = cleanData.map((bar) => bar.high - bar.low);
        const averageRanges = buildRollingAverage(ranges, lookback);

        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [averageRanges, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < 1) return null;

            const averageRange = averageRanges[i - 1]; // trailing range average
            const currentRange = ranges[i];
            const barMetrics = computePriceActionBarMetrics(cleanData[i]);

            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (averageRange === null || longLagEdge === null || shortLagEdge === null) return null;

            // Buy: bodyPct > minBodyPct, close > open, range expands, long reaction lag edge positive
            if (
                barMetrics.bodyPct > minBodyPct &&
                cleanData[i].close > cleanData[i].open &&
                currentRange > averageRange &&
                longLagEdge >= 0.01
            ) {
                return createBuySignal(cleanData, i, `Bullish body expansion ${barMetrics.bodyPct.toFixed(2)} with range expansion and lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: bodyPct > minBodyPct, close < open, range expands, short reaction lag edge positive
            if (
                barMetrics.bodyPct > minBodyPct &&
                cleanData[i].close < cleanData[i].open &&
                currentRange > averageRange &&
                shortLagEdge >= 0.01
            ) {
                return createSellSignal(cleanData, i, `Bearish body expansion ${barMetrics.bodyPct.toFixed(2)} with range expansion and lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minBodyPct", "lagSec"],
    },
};
