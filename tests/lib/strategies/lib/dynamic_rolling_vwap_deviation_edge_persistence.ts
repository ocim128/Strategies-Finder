import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingStdDev } from "./price-action-statistics-core";
import {
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        vwapLookback: Math.max(3, Math.round(Number(params.vwapLookback ?? 30))),
        deviationThreshold: Math.max(0.1, Number(params.deviationThreshold ?? 2.0)),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 3))),
    };
}

export const dynamic_rolling_vwap_deviation_edge_persistence: Strategy = {
    name: "Dynamic Rolling VWAP Deviation Edge Persistence",
    description: "Fades extreme price deviations from the rolling VWAP on Binance, gating entries on a persistent executable edge on Polymarket to exploit slow-moving market maker quotes.",
    defaultParams: {
        vwapLookback: 30,
        deviationThreshold: 2.0,
        persistenceSec: 3,
    },
    paramLabels: {
        vwapLookback: "VWAP Lookback",
        deviationThreshold: "Deviation Threshold",
        persistenceSec: "Edge Persistence Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const vwapLookback = p.vwapLookback as number;
        const deviationThreshold = p.deviationThreshold as number;
        const persistenceSec = p.persistenceSec as number;

        if (cleanData.length < vwapLookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const vwap = calculateVWAP(highs, lows, closes, volumes, vwapLookback);
        const stdDev = buildRollingStdDev(closes, vwapLookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: vwapLookback });

        if (!edge.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0.01,
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [vwap, stdDev, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const currentClose = closes[i];
            const currentVwap = vwap[i];
            const currentStd = stdDev[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (currentVwap === null || currentStd === null) return null;

            // Buy: Close < (VWAP - deviationThreshold * stdDev) & persistent YES edge
            if (currentClose < currentVwap - deviationThreshold * currentStd && yesEdgeSec >= persistenceSec) {
                return createBuySignal(cleanData, i, `Extreme VWAP undershoot ${currentClose.toFixed(2)} with persistent YES edge`);
            }

            // Sell: Close > (VWAP + deviationThreshold * stdDev) & persistent NO edge
            if (currentClose > currentVwap + deviationThreshold * currentStd && noEdgeSec >= persistenceSec) {
                return createSellSignal(cleanData, i, `Extreme VWAP overshoot ${currentClose.toFixed(2)} with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["vwapLookback", "deviationThreshold", "persistenceSec"],
    },
};
