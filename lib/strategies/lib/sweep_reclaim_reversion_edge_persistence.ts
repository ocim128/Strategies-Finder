import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        reclaimThreshold: Math.max(0.01, Math.min(1.0, Number(params.reclaimThreshold ?? 0.70))),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 4))),
    };
}

export const sweep_reclaim_reversion_edge_persistence: Strategy = {
    name: "Sweep Reclaim Reversion Edge Persistence",
    description: "Fades aggressive liquidity sweep and reclaim events on Binance, requiring a persistent executable price edge on Polymarket to exploit stale market maker quotes during volatile reclaims.",
    defaultParams: {
        lookback: 20,
        reclaimThreshold: 0.70,
        persistenceSec: 4,
    },
    paramLabels: {
        lookback: "Sweep Lookback",
        reclaimThreshold: "Reclaim Conviction",
        persistenceSec: "Edge Persistence Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const reclaimThreshold = p.reclaimThreshold as number;
        const persistenceSec = p.persistenceSec as number;

        if (cleanData.length < lookback + 1) return [];

        const reclaim = buildSweepReclaimSeries(cleanData, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0.01,
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [reclaim.bullish, reclaim.bearish, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const bullishReclaim = reclaim.bullish[i];
            const bearishReclaim = reclaim.bearish[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            // Buy: bullish reclaim conviction high and persistent same-side edge
            if (
                bullishReclaim !== null &&
                bullishReclaim >= reclaimThreshold &&
                yesEdgeSec >= persistenceSec &&
                actionability.yesActionable[i]
            ) {
                return createBuySignal(cleanData, i, `Bullish sweep reclaim ${bullishReclaim.toFixed(2)} with persistent YES edge`);
            }

            // Sell: bearish reclaim conviction high and persistent same-side edge
            if (
                bearishReclaim !== null &&
                bearishReclaim >= reclaimThreshold &&
                noEdgeSec >= persistenceSec &&
                actionability.noActionable[i]
            ) {
                return createSellSignal(cleanData, i, `Bearish sweep reclaim ${bearishReclaim.toFixed(2)} with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "reclaimThreshold", "persistenceSec"],
    },
};
