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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        imbalanceThreshold: Math.max(0.01, Math.min(0.99, Number(params.imbalanceThreshold ?? 0.70))),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 4))),
        minLag: Math.max(0.001, Number(params.minLag ?? 0.015)),
    };
}

export const wick_imbalance_reversal_reaction_lag: Strategy = {
    name: "Wick Imbalance Reversal Reaction Lag",
    description: "Fades extreme price extensions on Binance that exhibit significant wick imbalance (rejection of highs/lows), entering when the Polymarket order book reaction lag shows the contract is slow to adjust to the reversal.",
    defaultParams: {
        lookback: 15,
        imbalanceThreshold: 0.70,
        lagSec: 4,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "Imbalance Lookback",
        imbalanceThreshold: "Imbalance Threshold",
        lagSec: "Reaction Lag Seconds",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const imbalanceThreshold = p.imbalanceThreshold as number;
        const lagSec = p.lagSec as number;
        const minLag = p.minLag as number;

        if (cleanData.length < lookback) return [];

        const len = cleanData.length;
        const bullishRejections = new Array(len).fill(0);
        const bearishRejections = new Array(len).fill(0);

        for (let i = 0; i < len; i++) {
            const metrics = computePriceActionBarMetrics(cleanData[i]);
            const totalWick = metrics.upperWick + metrics.lowerWick;
            if (totalWick > 0) {
                bullishRejections[i] = metrics.lowerWick / (metrics.body + totalWick);
                bearishRejections[i] = metrics.upperWick / (metrics.body + totalWick);
            }
        }

        const avgBullish = buildRollingAverage(bullishRejections, lookback);
        const avgBearish = buildRollingAverage(bearishRejections, lookback);

        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [avgBullish, avgBearish, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const bull = avgBullish[i];
            const bear = avgBearish[i];
            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (bull === null || bear === null || longLagEdge === null || shortLagEdge === null) return null;

            // Buy: lower wick imbalance exceeds threshold (bullish rejection) & lag positive
            if (bull > imbalanceThreshold && longLagEdge >= minLag) {
                return createBuySignal(cleanData, i, `Bullish rejection ${bull.toFixed(2)} with lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: upper wick imbalance exceeds threshold (bearish rejection) & lag positive
            if (bear > imbalanceThreshold && shortLagEdge >= minLag) {
                return createSellSignal(cleanData, i, `Bearish rejection ${bear.toFixed(2)} with lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "imbalanceThreshold", "lagSec", "minLag"],
    },
};
