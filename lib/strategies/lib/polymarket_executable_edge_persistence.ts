import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function finiteParam(value: number | undefined, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePolymarketExecutableEdgePersistenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: Math.max(5, Math.round(finiteParam(params.volLookback, 45))),
        minEdge: Math.max(0, finiteParam(params.minEdge, 0.04)),
        persistenceSec: Math.max(1, Math.round(finiteParam(params.persistenceSec, 2))),
        maxSpread: Math.max(0, finiteParam(params.maxSpread, 0.04)),
    };
}

export const polymarket_executable_edge_persistence: Strategy = {
    name: "Polymarket Executable Edge Persistence",
    description: "Uses Binance-implied event probability as the fair side and enters only when the executable Polymarket ask stays mispriced for multiple 1s bars.",
    defaultParams: {
        volLookback: 45,
        minEdge: 0.04,
        persistenceSec: 2,
        maxSpread: 0.04,
    },
    paramLabels: {
        volLookback: "Fair Probability Vol Lookback",
        minEdge: "Minimum Executable Edge",
        persistenceSec: "Edge Persistence Seconds",
        maxSpread: "Maximum Side Spread",
    },
    normalizeParams: normalizePolymarketExecutableEdgePersistenceParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const normalized = normalizePolymarketExecutableEdgePersistenceParams(params);
        const volLookback = normalized.volLookback as number;
        const minEdge = normalized.minEdge as number;
        const persistenceSec = normalized.persistenceSec as number;
        const maxSpread = normalized.maxSpread as number;
        if (cleanData.length < volLookback + 1) return [];

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, {
            volLookback,
        });
        if (!edge.available) return [];

        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback,
            maxSpread,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge,
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [edge.fairYesProbability, edge.marketYesProbability], (i) => {
            const buyYesEdge = edge.buyYesEdge[i];
            if (
                buyYesEdge !== null
                && actionability.yesActionable[i]
                && buyYesEdge >= minEdge
                && persistence.yesEdgeSeconds[i] >= persistenceSec
            ) {
                return createBuySignal(cleanData, i, `YES executable edge ${buyYesEdge.toFixed(3)}`);
            }

            const buyNoEdge = edge.buyNoEdge[i];
            if (
                buyNoEdge !== null
                && actionability.noActionable[i]
                && buyNoEdge >= minEdge
                && persistence.noEdgeSeconds[i] >= persistenceSec
            ) {
                return createSellSignal(cleanData, i, `NO executable edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "minEdge", "persistenceSec", "maxSpread"],
    },
};
