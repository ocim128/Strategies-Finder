import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
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
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeMfiMedianParticipationAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const mfi_median_participation_alignment: Strategy = {
    name: "MFI Median Participation Alignment",
    description:
        "Uses Money Flow Index as a volume-weighted participation gate and pairs it with a trailing rolling median so daily entries stay anchored to a robust centerline.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeMfiMedianParticipationAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMfiMedianParticipationAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const mfi = calculateMFI(highs, lows, closes, volumes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [mfi, median], (i) => {
            if (i < lookback - 1) return null;

            const mfiValue = mfi[i];
            const med = median[i];
            if (mfiValue === null || med === null) return null;

            if (mfiValue > 50 && closes[i] > med) {
                return createBuySignal(cleanData, i, `MFI ${mfiValue.toFixed(2)} with close above median`);
            }
            if (mfiValue < 50 && closes[i] < med) {
                return createSellSignal(cleanData, i, `MFI ${mfiValue.toFixed(2)} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
