import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap, buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: Math.max(5, Math.round(Number(params.volLookback ?? 30))),
        progressGate: Math.max(0.1, Math.min(0.99, Number(params.progressGate ?? 0.70))),
        minLag: Math.max(0.001, Number(params.minLag ?? 0.01)),
    };
}

export const event_progress_acceleration_reaction_lag: Strategy = {
    name: "Event Progress Acceleration Reaction Lag",
    description: "Exploits accelerated shifts in Binance-implied fair probability as event progress nears expiry, entering when Polymarket has underreacted to the rapidly decaying remaining volatility envelope.",
    defaultParams: {
        volLookback: 30,
        progressGate: 0.70,
        minLag: 0.01,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        progressGate: "Progress Gate Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const progressGate = p.progressGate as number;
        const minLag = p.minLag as number;

        if (cleanData.length < volLookback + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback, lagSec: 3 });

        if (!pressure.available || !reaction.available) return [];

        return createSignalLoop(cleanData, [pressure.spotYesProbability, pressure.eventProgress, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < 1) return null;

            const prevProb = pressure.spotYesProbability[i - 1];
            const currentProb = pressure.spotYesProbability[i];
            const currentProgress = pressure.eventProgress[i];

            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (currentProb === null || prevProb === null || currentProgress === null || longLagEdge === null || shortLagEdge === null) return null;

            const probChange = currentProb - prevProb;

            // Buy: eventProgress > progressGate, fair YES probability change is positive, and Polymarket longLagEdge positive
            if (currentProgress > progressGate && probChange > 0 && longLagEdge >= minLag) {
                return createBuySignal(cleanData, i, `Gamma accelerated fair YES breakout (${currentProb.toFixed(2)}) late-stage progress with reaction lag`);
            }

            // Sell: eventProgress > progressGate, fair YES probability change is negative, and Polymarket shortLagEdge positive
            if (currentProgress > progressGate && probChange < 0 && shortLagEdge >= minLag) {
                return createSellSignal(cleanData, i, `Gamma accelerated fair YES breakdown (${currentProb.toFixed(2)}) late-stage progress with reaction lag`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "progressGate", "minLag"],
    },
};
