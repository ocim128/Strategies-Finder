import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeVolumeAcceptanceCompositeOrParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 21))),
        z_threshold: Math.max(0, Number(params.z_threshold ?? 2)),
    };
}

export const volume_acceptance_composite_or: Strategy = {
    name: "Volume Acceptance Composite OR",
    description:
        "Signals either persistent directional close acceptance or a volume z-score surge with matching daily close direction.",
    defaultParams: {
        lookback: 21,
        z_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        z_threshold: "Z Threshold",
    },
    normalizeParams: normalizeVolumeAcceptanceCompositeOrParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeAcceptanceCompositeOrParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.z_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const averageAcceptance = buildRollingAverage(acceptance, lookback);
        const volumeZScore = buildRollingZScore(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [averageAcceptance, volumeZScore], (i) => {
            const avgAcceptance = averageAcceptance[i];
            const volumeZ = volumeZScore[i];
            if (avgAcceptance === null || volumeZ === null) return null;

            const bullishClose = cleanData[i].close > cleanData[i].open;
            const bearishClose = cleanData[i].close < cleanData[i].open;
            const acceptanceLong = avgAcceptance > 0.6 || acceptance[i] > 0.8;
            const acceptanceShort = avgAcceptance < -0.6 || acceptance[i] < -0.8;
            const surgeLong = volumeZ > zThreshold && bullishClose;
            const surgeShort = volumeZ > zThreshold && bearishClose;

            const longSignal = acceptanceLong || surgeLong;
            const shortSignal = acceptanceShort || surgeShort;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Volume/acceptance composite long z=${volumeZ.toFixed(2)}`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Volume/acceptance composite short z=${volumeZ.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "z_threshold"],
    },
};
