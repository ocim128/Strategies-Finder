import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

function normalizeMedianBreakoutVolumeConfirmedParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.45))),
    };
}

export const median_breakout_volume_confirmed: Strategy = {
    name: "Median Breakout Volume Confirmed",
    description: "Rolling median breakout with proxy volume confirmation.",
    defaultParams: {
        lookback: 30,
        volumePercentileMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeMedianBreakoutVolumeConfirmedParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMedianBreakoutVolumeConfirmedParams(params);
        const lookback = p.lookback as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [median, volumePercentile], (i) => {
            const med = median[i];
            const volPct = volumePercentile[i];
            if (med === null || volPct === null) return null;

            const close = closes[i];
            if (volPct > volumePercentileMin) {
                if (close > med) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Close ${close.toFixed(4)} broke above rolling median ${med.toFixed(4)} with volume percentile ${volPct.toFixed(2)}`
                    );
                }
                if (close < med) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Close ${close.toFixed(4)} broke below rolling median ${med.toFixed(4)} with volume percentile ${volPct.toFixed(2)}`
                    );
                }
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
