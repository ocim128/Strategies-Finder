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
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        mfiLookback: Math.max(2, Math.round(Number(params.mfiLookback ?? 14))),
        mfiThreshold: Math.max(1, Math.min(49, Number(params.mfiThreshold ?? 20))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const mfi_divergence_executable_edge: Strategy = {
    name: "MFI Divergence Executable Edge",
    description: "Exploits spot extreme oversold/overbought price-volume exhaustion states on Binance, executing trades only when Polymarket market-maker quotes lag the reversion and present a highly-favorable executable edge.",
    defaultParams: {
        mfiLookback: 14,
        mfiThreshold: 20,
        minEdge: 0.01,
    },
    paramLabels: {
        mfiLookback: "MFI Lookback",
        mfiThreshold: "MFI Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const mfiLookback = p.mfiLookback as number;
        const mfiThreshold = p.mfiThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < mfiLookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const mfi = calculateMFI(highs, lows, closes, volumes, mfiLookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: mfiLookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: mfiLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [mfi, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const currentMfi = mfi[i];
            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (currentMfi === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: MFI oversold (< threshold), yesActionable is true, buyYesEdge >= minEdge
            if (currentMfi < mfiThreshold && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `MFI oversold ${currentMfi.toFixed(1)} with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: MFI overbought (> 100 - threshold), noActionable is true, buyNoEdge >= minEdge
            const upperThreshold = 100 - mfiThreshold;
            if (currentMfi > upperThreshold && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `MFI overbought ${currentMfi.toFixed(1)} with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfiLookback", "mfiThreshold", "minEdge"],
    },
};
