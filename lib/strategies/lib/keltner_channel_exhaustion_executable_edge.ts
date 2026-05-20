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
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        keltnerLookback: Math.max(2, Math.round(Number(params.keltnerLookback ?? 25))),
        atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 2.0)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const keltner_channel_exhaustion_executable_edge: Strategy = {
    name: "Keltner Channel Exhaustion Executable Edge",
    description: "Fades extreme price exhaustion outside of local Keltner Channel boundaries on Binance, entering when Polymarket order books lag the spot snapback and offer an actionable executable edge.",
    defaultParams: {
        keltnerLookback: 25,
        atrMultiplier: 2.0,
        minEdge: 0.01,
    },
    paramLabels: {
        keltnerLookback: "Keltner Lookback",
        atrMultiplier: "ATR Multiplier",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const keltnerLookback = p.keltnerLookback as number;
        const atrMultiplier = p.atrMultiplier as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < keltnerLookback) return [];

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

        return createSignalLoop(cleanData, [channel.upper, channel.lower, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const prevClose = cleanData[i - 1].close;
            const currentClose = cleanData[i].close;
            const prevLower = channel.lower[i - 1];
            const currentLower = channel.lower[i];
            const prevUpper = channel.upper[i - 1];
            const currentUpper = channel.upper[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (
                prevLower === null || currentLower === null ||
                prevUpper === null || currentUpper === null ||
                buyYesEdge === null || buyNoEdge === null
            ) return null;

            // Buy: Close crosses back above lower Keltner band
            if (prevClose < prevLower && currentClose >= currentLower && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Close crossed back above lower Keltner band with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: Close crosses back below upper Keltner band
            if (prevClose > prevUpper && currentClose <= currentUpper && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Close crossed back below upper Keltner band with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["keltnerLookback", "atrMultiplier", "minEdge"],
    },
};
