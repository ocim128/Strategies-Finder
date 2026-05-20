import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        decayFactor: Math.max(0.01, Math.min(0.99, Number(params.decayFactor ?? 0.80))),
        gapThreshold: Math.max(0.0001, Number(params.gapThreshold ?? 0.005)),
    };
}

export const gap_accumulation_velocity_reaction_lag: Strategy = {
    name: "Gap Accumulation Velocity Reaction Lag",
    description: "Exploits rapid gap-driven sweep transitions on Binance by accumulating the directional gap size between consecutive bars, entering when Polymarket has lagged in incorporating the sudden structural shift.",
    defaultParams: {
        lookback: 15,
        decayFactor: 0.80,
        gapThreshold: 0.005,
    },
    paramLabels: {
        lookback: "Decay Lookback",
        decayFactor: "Decay Factor",
        gapThreshold: "Minimum Accumulated Gap",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const decayFactor = p.decayFactor as number;
        const gapThreshold = p.gapThreshold as number;

        if (cleanData.length < lookback) return [];

        const len = cleanData.length;
        const gapPct = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
            const prevClose = cleanData[i - 1].close;
            gapPct[i] = prevClose > 0 ? (cleanData[i].open - prevClose) / prevClose : 0;
        }

        const posGaps = gapPct.map((g) => (g > 0 ? g : 0));
        const negGaps = gapPct.map((g) => (g < 0 ? g : 0));

        const accumPos = buildCumulativeDecaySum(posGaps, decayFactor);
        const accumNeg = buildCumulativeDecaySum(negGaps, decayFactor);

        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec: 3 });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [accumPos, accumNeg, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const posSum = accumPos[i];
            const negSum = accumNeg[i];
            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (posSum === null || negSum === null || longLagEdge === null || shortLagEdge === null) return null;

            // Buy: decayed positive gap sum exceeds gapThreshold and Polymarket longLagEdge positive
            if (posSum > gapThreshold && longLagEdge >= 0.01) {
                return createBuySignal(cleanData, i, `Decayed positive gap sum ${posSum.toFixed(4)} exceeds threshold with lag edge`);
            }

            // Sell: decayed negative gap sum falls below negative gapThreshold
            if (negSum < -gapThreshold && shortLagEdge >= 0.01) {
                return createSellSignal(cleanData, i, `Decayed negative gap sum ${negSum.toFixed(4)} below threshold with lag edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decayFactor", "gapThreshold"],
    },
};
