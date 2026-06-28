import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRateOfChange, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodySpikeVolumeConfirmationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        bodyPercentileMin: Math.max(0, Math.min(1, Number(params.bodyPercentileMin ?? 0.70))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.55))),
    };
}

export const body_spike_volume_confirmation: Strategy = {
    name: "Body Spike Volume Confirmation",
    description: "Large body percentage bars confirmed by proxy volume.",
    defaultParams: {
        lookback: 30,
        bodyPercentileMin: 0.70,
        volumePercentileMin: 0.55,
    },
    paramLabels: {
        lookback: "Lookback",
        bodyPercentileMin: "Body Percentile Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeBodySpikeVolumeConfirmationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodySpikeVolumeConfirmationParams(params);
        const lookback = p.lookback as number;
        const bodyPercentileMin = p.bodyPercentileMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const bodyPercentile = buildPercentileRank(bodyPct, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [bodyPercentile, volumePercentile, returns], (i) => {
            const bodyPctRank = bodyPercentile[i];
            const volPct = volumePercentile[i];
            const ret = returns[i];
            if (bodyPctRank === null || volPct === null || ret === null) return null;

            if (bodyPctRank > bodyPercentileMin && volPct > volumePercentileMin) {
                if (ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Body spike buy: body percentile ${bodyPctRank.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
                if (ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Body spike sell: body percentile ${bodyPctRank.toFixed(2)}, vol percentile ${volPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "bodyPercentileMin", "volumePercentileMin"],
    },
};
