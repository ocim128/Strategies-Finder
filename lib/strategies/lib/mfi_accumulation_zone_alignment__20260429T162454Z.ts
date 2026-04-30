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
import { calculateMFI, calculateSMA } from "../indicators";

const MFI_ACCUMULATION_ZONE_PERIOD = 14;

function normalizeMfiAccumulationZoneAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        mfi_threshold: Math.max(50, Math.min(99, Number(params.mfi_threshold ?? 60))),
        avg_lookback: Math.max(2, Math.round(Number(params.avg_lookback ?? 100))),
    };
}

export const mfi_accumulation_zone_alignment: Strategy = {
    name: "MFI Accumulation Zone Alignment",
    description:
        "Requires a volume-backed MFI conviction zone before allowing price to align with a longer-term SMA trend baseline.",
    defaultParams: {
        mfi_threshold: 60,
        avg_lookback: 100,
    },
    paramLabels: {
        mfi_threshold: "MFI Threshold",
        avg_lookback: "Average Lookback",
    },
    normalizeParams: normalizeMfiAccumulationZoneAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMfiAccumulationZoneAlignmentParams(params);
        const averageLookback = p.avg_lookback as number;
        const mfiThreshold = p.mfi_threshold as number;
        if (cleanData.length < Math.max(averageLookback, MFI_ACCUMULATION_ZONE_PERIOD) + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const mfi = calculateMFI(highs, lows, closes, volumes, MFI_ACCUMULATION_ZONE_PERIOD);
        const average = calculateSMA(closes, averageLookback);

        return createSignalLoop(cleanData, [mfi, average], (i) => {
            const mfiValue = mfi[i];
            const avg = average[i];
            if (mfiValue === null || avg === null) return null;

            if (mfiValue > mfiThreshold && closes[i] > avg) {
                return createBuySignal(cleanData, i, `MFI ${mfiValue.toFixed(1)} above threshold with close above SMA`);
            }
            if (mfiValue < 100 - mfiThreshold && closes[i] < avg) {
                return createSellSignal(cleanData, i, `MFI ${mfiValue.toFixed(1)} below inverse threshold with close below SMA`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfi_threshold", "avg_lookback"],
    },
};
