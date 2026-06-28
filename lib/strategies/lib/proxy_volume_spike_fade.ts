import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeProxyVolumeSpikeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.85))),
    };
}

export const proxy_volume_spike_fade: Strategy = {
    name: "Proxy Volume Spike Fade",
    description: "Proxy volume exhaustion on extreme percentile.",
    defaultParams: {
        lookback: 30,
        volumePercentileMin: 0.85,
    },
    paramLabels: {
        lookback: "Lookback",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeProxyVolumeSpikeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeProxyVolumeSpikeFadeParams(params);
        const lookback = p.lookback as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);
        const returns = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [volumePercentile, returns], (i) => {
            const volPct = volumePercentile[i];
            const ret = returns[i];
            if (volPct === null || ret === null) return null;

            if (volPct > volumePercentileMin && ret < 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Volume percentile ${volPct.toFixed(2)} with negative return (fade buy)`
                );
            }
            if (volPct > volumePercentileMin && ret > 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Volume percentile ${volPct.toFixed(2)} with positive return (fade sell)`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volumePercentileMin"],
    },
};
