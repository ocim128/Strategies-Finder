import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        reclaimThreshold: Math.max(0.01, Math.min(1.0, Number(params.reclaimThreshold ?? 0.75))),
        minLag: Math.max(0, Number(params.minLag ?? 0.015)),
    };
}

export const sweep_reclaim_reaction_lag: Strategy = {
    name: "Sweep Reclaim Reaction Lag",
    description: "Fades aggressive liquidity sweep and reclaim events on Binance, entering counter-trend reversions only when the Polymarket reaction gap confirms the CLOB has not yet priced in the reclamation.",
    defaultParams: {
        lookback: 25,
        reclaimThreshold: 0.75,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "Sweep Lookback",
        reclaimThreshold: "Reclaim Conviction",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const reclaimThreshold = p.reclaimThreshold as number;
        const minLag = p.minLag as number;

        if (cleanData.length < lookback + 1) return [];

        const reclaim = buildSweepReclaimSeries(cleanData, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec: 3 });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [reclaim.bullish, reclaim.bearish, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const bullishReclaim = reclaim.bullish[i];
            const bearishReclaim = reclaim.bearish[i];

            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (longLagEdge === null || shortLagEdge === null) return null;

            // Buy: bullish reclaim conviction >= reclaimThreshold, longLagEdge >= minLag
            if (bullishReclaim !== null && bullishReclaim >= reclaimThreshold && longLagEdge >= minLag) {
                return createBuySignal(cleanData, i, `Bullish sweep reclaim ${bullishReclaim.toFixed(2)} with reaction lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: bearish reclaim conviction >= reclaimThreshold, shortLagEdge >= minLag
            if (bearishReclaim !== null && bearishReclaim >= reclaimThreshold && shortLagEdge >= minLag) {
                return createSellSignal(cleanData, i, `Bearish sweep reclaim ${bearishReclaim.toFixed(2)} with reaction lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "reclaimThreshold", "minLag"],
    },
};
