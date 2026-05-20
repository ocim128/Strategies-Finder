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
import { calculateMFI } from "../indicators";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        mfiLookback: Math.max(2, Math.round(Number(params.mfiLookback ?? 14))),
        mfiThreshold: Math.max(1, Math.min(49, Number(params.mfiThreshold ?? 20))),
        minLag: Math.max(0, Number(params.minLag ?? 0.015)),
    };
}

export const money_flow_index_exhaustion_reaction_lag: Strategy = {
    name: "Money Flow Index Exhaustion Reaction Lag",
    description: "Identifies price-volume overbought/oversold extremes on Binance using the Money Flow Index (MFI) and enters mean reversions, gating trades on Polymarket reaction lag edges.",
    defaultParams: {
        mfiLookback: 14,
        mfiThreshold: 20,
        minLag: 0.015,
    },
    paramLabels: {
        mfiLookback: "MFI Lookback",
        mfiThreshold: "MFI Threshold",
        minLag: "Minimum Reaction Lag",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const mfiLookback = p.mfiLookback as number;
        const mfiThreshold = p.mfiThreshold as number;
        const minLag = p.minLag as number;

        if (cleanData.length < mfiLookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const mfi = calculateMFI(highs, lows, closes, volumes, mfiLookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: mfiLookback, lagSec: 3 });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [mfi, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < 1) return null;

            const currentMfi = mfi[i];
            const prevMfi = mfi[i - 1];
            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (currentMfi === null || prevMfi === null || longLagEdge === null || shortLagEdge === null) return null;

            // Buy: MFI oversold (< threshold) and hooking up
            if (currentMfi < mfiThreshold && currentMfi > prevMfi && longLagEdge >= minLag) {
                return createBuySignal(cleanData, i, `MFI oversold ${currentMfi.toFixed(1)} hooking up with lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: MFI overbought (> 100 - threshold) and hooking down
            const upperThreshold = 100 - mfiThreshold;
            if (currentMfi > upperThreshold && currentMfi < prevMfi && shortLagEdge >= minLag) {
                return createSellSignal(cleanData, i, `MFI overbought ${currentMfi.toFixed(1)} hooking down with lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfiLookback", "mfiThreshold", "minLag"],
    },
};
