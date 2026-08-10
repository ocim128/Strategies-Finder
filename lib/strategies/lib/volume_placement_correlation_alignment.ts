import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeVolumePlacementCorrelationAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_placement_correlation_alignment: Strategy = {
    name: "Volume Placement Correlation Alignment",
    description: "Aligns with the side where heavy proxy-volume bars close when close location and volume percentile correlate strongly.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumePlacementCorrelationAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumePlacementCorrelationAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);
        const volPctClean = volPct.map((v) => v ?? 0);
        const correlation = buildRollingCorrelation(closeLocation, volPctClean, lookback);

        return createSignalLoop(cleanData, [correlation, volPct], (i) => {
            if (i < lookback) return null;
            const corr = correlation[i];
            const vp = volPct[i];
            if (corr === null || vp === null) return null;

            if (corr > 0.5 && vp > 0.5 && closeLocation[i] > 0.5) {
                return createBuySignal(cleanData, i, `Volume-placement correlation ${corr.toFixed(2)} with heavy volume closing high`);
            }
            if (corr < -0.5 && vp > 0.5 && closeLocation[i] < 0.5) {
                return createSellSignal(cleanData, i, `Volume-placement correlation ${corr.toFixed(2)} with heavy volume closing low`);
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
