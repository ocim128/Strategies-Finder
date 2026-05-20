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
import { calculateSessionVWAP } from "../indicators";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        vwapLookback: Math.max(3, Math.round(Number(params.vwapLookback ?? 30))),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 3))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const session_vwap_center_band_edge_persistence: Strategy = {
    name: "Session VWAP Center Band Edge Persistence",
    description: "Enters trend-following positions on Binance when price pulls back to the session volume-weighted average price (VWAP) and rebounds, gating trades on a persistent executable edge on Polymarket.",
    defaultParams: {
        vwapLookback: 30,
        persistenceSec: 3,
        minEdge: 0.01,
    },
    paramLabels: {
        vwapLookback: "Trend/CMF Lookback",
        persistenceSec: "Edge Persistence Seconds",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const vwapLookback = p.vwapLookback as number;
        const persistenceSec = p.persistenceSec as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < vwapLookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const times = cleanData.map((bar) => bar.time);

        const vwap = calculateSessionVWAP(highs, lows, closes, volumes, times);

        // Simple trend direction filter: close is above vwapLookback-period SMA of VWAP
        const vwapSma = new Array(closes.length).fill(null);
        let sum = 0;
        for (let i = 0; i < closes.length; i++) {
            const v = vwap[i];
            if (v !== null) sum += v;
            if (i >= vwapLookback) {
                const prevV = vwap[i - vwapLookback];
                if (prevV !== null) sum -= prevV;
            }
            if (i >= vwapLookback - 1) {
                vwapSma[i] = sum / vwapLookback;
            }
        }

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: vwapLookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: vwapLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge,
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [vwap, vwapSma, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const prevClose = closes[i - 1];
            const currentClose = closes[i];
            const currentVwap = vwap[i];
            const prevVwap = vwap[i - 1];
            const currentVwapSma = vwapSma[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (currentVwap === null || prevVwap === null || currentVwapSma === null || buyYesEdge === null || buyNoEdge === null) return null;

            const trendUp = currentVwap > currentVwapSma;
            const trendDown = currentVwap < currentVwapSma;

            // Buy: Close crosses above session VWAP, trend is up, persistent YES edge
            if (prevClose < prevVwap && currentClose >= currentVwap && trendUp && yesEdgeSec >= persistenceSec && actionability.yesActionable[i]) {
                return createBuySignal(cleanData, i, `Pullback to session VWAP reclaimed up with trend alignment and persistent YES edge`);
            }

            // Sell: Close crosses below session VWAP, trend is down, persistent NO edge
            if (prevClose > prevVwap && currentClose <= currentVwap && trendDown && noEdgeSec >= persistenceSec && actionability.noActionable[i]) {
                return createSellSignal(cleanData, i, `Pullback to session VWAP reclaimed down with trend alignment and persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["vwapLookback", "persistenceSec", "minEdge"],
    },
};
