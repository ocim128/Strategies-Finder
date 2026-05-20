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
        volLookback: Math.max(5, Math.round(Number(params.volLookback ?? 25))),
        progressThreshold: Math.max(0.1, Math.min(0.99, Number(params.progressThreshold ?? 0.75))),
        minLag: Math.max(0.001, Number(params.minLag ?? 0.010)),
    };
}

export const event_progress_volatility_shift_reaction_lag: Strategy = {
    name: "Event Progress Volatility Shift Reaction Lag",
    description: "Exploits sudden shifts in Binance-implied fair probability during late-stage event progress, entering when Polymarket lags in adjusting its mid-price to the compressed volatility envelope.",
    defaultParams: {
        volLookback: 25,
        progressThreshold: 0.75,
        minLag: 0.010,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        progressThreshold: "Progress Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const progressThreshold = p.progressThreshold as number;
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

            // Buy: eventProgress > progressThreshold, fair YES prob change is positive, longLagEdge >= minLag
            if (currentProgress > progressThreshold && probChange > 0 && longLagEdge >= minLag) {
                return createBuySignal(cleanData, i, `Late-stage progress ${currentProgress.toFixed(2)} fair YES jump with lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: eventProgress > progressThreshold, fair YES prob change is negative, shortLagEdge >= minLag
            if (currentProgress > progressThreshold && probChange < 0 && shortLagEdge >= minLag) {
                return createSellSignal(cleanData, i, `Late-stage progress ${currentProgress.toFixed(2)} fair YES drop with lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "progressThreshold", "minLag"],
    },
};
