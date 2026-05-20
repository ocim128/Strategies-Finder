import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
        squeezeThreshold: Math.max(0.01, Number(params.squeezeThreshold ?? 0.12)),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 3))),
    };
}

export const close_acceptance_squeeze_edge_persistence: Strategy = {
    name: "Close Acceptance Squeeze Edge Persistence",
    description: "Identifies price breakouts from extreme close-acceptance compression zones on Binance, using the persistence of an executable edge on Polymarket to confirm breakout validity.",
    defaultParams: {
        lookback: 25,
        squeezeThreshold: 0.12,
        persistenceSec: 3,
    },
    paramLabels: {
        lookback: "Acceptance Lookback",
        squeezeThreshold: "Squeeze Threshold",
        persistenceSec: "Edge Persistence Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const squeezeThreshold = p.squeezeThreshold as number;
        const persistenceSec = p.persistenceSec as number;

        if (cleanData.length < lookback + 1) return [];

        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const rollingStd = buildRollingStdDev(closeAcceptance, lookback);

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

        return createSignalLoop(cleanData, [rollingStd, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const std = rollingStd[i];
            const acceptance = closeAcceptance[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (std === null || acceptance === null) return null;

            // Buy: Std of acceptance < squeezeThreshold, acceptance > 0.8, persistent YES edge
            if (std < squeezeThreshold && acceptance > 0.8 && yesEdgeSec >= persistenceSec && actionability.yesActionable[i]) {
                return createBuySignal(cleanData, i, `Close acceptance squeeze breakout up (${acceptance.toFixed(2)}) with persistent YES edge`);
            }

            // Sell: Std of acceptance < squeezeThreshold, acceptance < 0.2, persistent NO edge
            if (std < squeezeThreshold && acceptance < 0.2 && noEdgeSec >= persistenceSec && actionability.noActionable[i]) {
                return createSellSignal(cleanData, i, `Close acceptance squeeze breakout down (${acceptance.toFixed(2)}) with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "squeezeThreshold", "persistenceSec"],
    },
};
