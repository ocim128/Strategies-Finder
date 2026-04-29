import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeVolumePercentileGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        volume_threshold: Math.max(50, Math.min(99, Number(params.volume_threshold ?? 70))),
    };
}

export const volume_percentile_gated_median_alignment: Strategy = {
    name: "Volume Percentile Gated Median Alignment",
    description:
        "Uses trailing volume percentile as a participation gate and only aligns entries with the rolling median once relative activity is already elevated.",
    defaultParams: {
        lookback: 63,
        volume_threshold: 70,
    },
    paramLabels: {
        lookback: "Lookback",
        volume_threshold: "Volume Threshold",
    },
    normalizeParams: normalizeVolumePercentileGatedMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumePercentileGatedMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        const threshold = (p.volume_threshold as number) / 100;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const volumeRank = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [median, volumeRank], (i) => {
            const m = median[i];
            const rank = volumeRank[i];
            if (m === null || rank === null || rank <= threshold) return null;

            if (closes[i] > m) {
                return createBuySignal(cleanData, i, `High volume percentile ${(rank * 100).toFixed(1)}% with close above median`);
            }
            if (closes[i] < m) {
                return createSellSignal(cleanData, i, `High volume percentile ${(rank * 100).toFixed(1)}% with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volume_threshold"],
    },
};
