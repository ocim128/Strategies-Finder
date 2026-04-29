import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";

function normalizeVolumeBlowoffReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        vol_mult: Math.max(0.1, Number(params.vol_mult ?? 3)),
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const volume_blowoff_reversion: Strategy = {
    name: "Volume Blowoff Reversion",
    description:
        "Fades climactic volume spikes only when the close is simultaneously printing an inclusive rolling close extreme.",
    defaultParams: {
        vol_mult: 3,
        lookback: 20,
    },
    paramLabels: {
        vol_mult: "Volume Multiplier",
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeBlowoffReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeBlowoffReversionParams(params);
        const lookback = p.lookback as number;
        const volumeMultiplier = p.vol_mult as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const averageVolume = buildRollingAverage(volumes, lookback);
        const closeExtremes = buildRollingMinMax(closes, lookback);

        return createSignalLoop(cleanData, [averageVolume, closeExtremes.min, closeExtremes.max], (i) => {
            const avgVolume = averageVolume[i];
            const minClose = closeExtremes.min[i];
            const maxClose = closeExtremes.max[i];
            if (avgVolume === null || minClose === null || maxClose === null || avgVolume <= 0) return null;
            if (volumes[i] <= volumeMultiplier * avgVolume) return null;

            if (closes[i] <= minClose) {
                return createBuySignal(cleanData, i, "Blowoff volume at rolling close low");
            }
            if (closes[i] >= maxClose) {
                return createSellSignal(cleanData, i, "Blowoff volume at rolling close high");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["vol_mult", "lookback"],
    },
};
