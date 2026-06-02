import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { calculateCMF } from "../indicators";

// #COMPLETION_DRIVE: Assuming money-flow confirmation and close location rolling average align correctly and are causal.
// #SUGGEST_VERIFY: Verify threshold comparisons don't fail under low liquidity (where CMF could be zero).
function normalizeCmfGatedCloseLocationAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        clsLocThreshold: Math.max(0.5, Math.min(0.99, Number(params.clsLocThreshold ?? 0.7))),
    };
}

export const cmf_gated_close_location_alignment: Strategy = {
    name: "CMF Gated Close Location Alignment",
    description: "Close-location pressure at range extremes is gated by Chaikin Money Flow to verify volume-backed conviction.",
    defaultParams: {
        lookback: 30,
        clsLocThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        clsLocThreshold: "Close Location Threshold",
    },
    normalizeParams: normalizeCmfGatedCloseLocationAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfGatedCloseLocationAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgCloseLoc = buildRollingAverage(closeLocation, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [avgCloseLoc, cmf], (i) => {
            if (i < lookback) return null;
            const currentAvgLoc = avgCloseLoc[i];
            const currentCmf = cmf[i];

            if (currentAvgLoc === null || currentCmf === null) return null;

            // Buy logic: Rolling average close location is greater than clsLocThreshold and CMF is positive.
            if (currentAvgLoc > p.clsLocThreshold && currentCmf > 0) {
                return createBuySignal(cleanData, i, `CMF Gated Close Location Bullish (avgLoc=${currentAvgLoc.toFixed(3)}, CMF=${currentCmf.toFixed(3)})`);
            }

            // Sell logic: Rolling average close location is less than 1 minus clsLocThreshold and CMF is negative.
            if (currentAvgLoc < 1 - (p.clsLocThreshold as number) && currentCmf < 0) {
                return createSellSignal(cleanData, i, `CMF Gated Close Location Bearish (avgLoc=${currentAvgLoc.toFixed(3)}, CMF=${currentCmf.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clsLocThreshold"],
    },
};
