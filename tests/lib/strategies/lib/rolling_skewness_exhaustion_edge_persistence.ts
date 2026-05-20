import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        skewThreshold: Math.max(0.1, Number(params.skewThreshold ?? 1.5)),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 3))),
    };
}

export const rolling_skewness_exhaustion_edge_persistence: Strategy = {
    name: "Rolling Skewness Exhaustion Edge Persistence",
    description: "Exploits extreme directional return imbalances (fat-tailed skewness) on Binance, entering reversions once spot return distribution normalizes, backed by a persistent Polymarket executable edge.",
    defaultParams: {
        lookback: 30,
        skewThreshold: 1.5,
        persistenceSec: 3,
    },
    paramLabels: {
        lookback: "Skewness Lookback",
        skewThreshold: "Skewness Threshold",
        persistenceSec: "Edge Persistence Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const skewThreshold = p.skewThreshold as number;
        const persistenceSec = p.persistenceSec as number;

        if (cleanData.length < lookback + 1) return [];

        // Calculate close returns
        const returns = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const prev = cleanData[i - 1].close;
            returns[i] = prev > 0 ? (cleanData[i].close - prev) / prev : 0;
        }

        const skewness = buildRollingSkewness(returns, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0.01, // fallback minimum edge for counting seconds
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [skewness, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const prevSkew = skewness[i - 1];
            const currentSkew = skewness[i];
            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (prevSkew === null || currentSkew === null) return null;

            // Buy: negative skewness crosses back above -skewThreshold (normalization)
            if (prevSkew < -skewThreshold && currentSkew >= -skewThreshold && yesEdgeSec >= persistenceSec && actionability.yesActionable[i]) {
                return createBuySignal(cleanData, i, `Negative skewness ${currentSkew.toFixed(2)} normalized with persistent YES edge`);
            }

            // Sell: positive skewness crosses back below skewThreshold (normalization)
            if (prevSkew > skewThreshold && currentSkew <= skewThreshold && noEdgeSec >= persistenceSec && actionability.noActionable[i]) {
                return createSellSignal(cleanData, i, `Positive skewness ${currentSkew.toFixed(2)} normalized with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "persistenceSec"],
    },
};
