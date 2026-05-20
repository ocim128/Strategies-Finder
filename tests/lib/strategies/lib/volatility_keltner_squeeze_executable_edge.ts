import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        keltnerLookback: Math.max(2, Math.round(Number(params.keltnerLookback ?? 20))),
        atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 1.5)),
        persistenceSec: Math.max(1, Math.round(Number(params.persistenceSec ?? 3))),
    };
}

export const volatility_keltner_squeeze_executable_edge: Strategy = {
    name: "Volatility Keltner Squeeze Executable Edge",
    description: "Identifies low-volatility squeeze contraction phases on Binance and enters on decisive channel breakouts, using a persistent executable edge on Polymarket to secure a favorable probability rate.",
    defaultParams: {
        keltnerLookback: 20,
        atrMultiplier: 1.5,
        persistenceSec: 3,
    },
    paramLabels: {
        keltnerLookback: "Keltner Lookback",
        atrMultiplier: "ATR Multiplier",
        persistenceSec: "Edge Persistence Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const keltnerLookback = p.keltnerLookback as number;
        const atrMultiplier = p.atrMultiplier as number;
        const persistenceSec = p.persistenceSec as number;

        if (cleanData.length < keltnerLookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const channel = calculateKeltnerChannels(highs, lows, closes, keltnerLookback, keltnerLookback, atrMultiplier);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: keltnerLookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: keltnerLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        const persistence = buildPolymarket1sEdgePersistence(edge, {
            minEdge: 0.01,
            ewmaLookback: persistenceSec,
        });

        return createSignalLoop(cleanData, [channel.upper, channel.lower, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const prevClose = closes[i - 1];
            const currentClose = closes[i];
            const prevUpper = channel.upper[i - 1];
            const currentUpper = channel.upper[i];
            const prevLower = channel.lower[i - 1];
            const currentLower = channel.lower[i];

            const yesEdgeSec = persistence.yesEdgeSeconds[i];
            const noEdgeSec = persistence.noEdgeSeconds[i];

            if (
                prevUpper === null || currentUpper === null ||
                prevLower === null || currentLower === null
            ) return null;

            // Simple Keltner squeeze check: the Keltner bandwidth at i-1 was compressed compared to trailing average
            let prevBandwidth = prevUpper - prevLower;
            let sumBw = 0;
            let count = 0;
            for (let j = Math.max(0, i - keltnerLookback - 1); j < i - 1; j++) {
                const u = channel.upper[j];
                const l = channel.lower[j];
                if (u !== null && l !== null) {
                    sumBw += (u - l);
                    count++;
                }
            }
            const avgBandwidth = count > 0 ? sumBw / count : prevBandwidth;
            const isSqueezed = prevBandwidth < 0.90 * avgBandwidth;

            // Buy: Close crosses above upper Keltner band, Keltner squeeze setup, yesEdgeSeconds >= persistenceSec
            if (prevClose < prevUpper && currentClose >= currentUpper && isSqueezed && yesEdgeSec >= persistenceSec && actionability.yesActionable[i]) {
                return createBuySignal(cleanData, i, `Keltner upper band breakout (${currentClose.toFixed(2)}) from squeeze with persistent YES edge`);
            }

            // Sell: Close crosses below lower Keltner band, Keltner squeeze setup, noEdgeSeconds >= persistenceSec
            if (prevClose > prevLower && currentClose <= currentLower && isSqueezed && noEdgeSec >= persistenceSec && actionability.noActionable[i]) {
                return createSellSignal(cleanData, i, `Keltner lower band breakout (${currentClose.toFixed(2)}) from squeeze with persistent NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["keltnerLookback", "atrMultiplier", "persistenceSec"],
    },
};
