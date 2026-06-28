import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeInitiativePressureVolumeFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.45))),
    };
}

export const initiative_pressure_volume_follow: Strategy = {
    name: "Initiative Pressure Volume Follow",
    description: "Initiative pressure confirmed by proxy volume.",
    defaultParams: {
        lookback: 25,
        volumePercentileMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeInitiativePressureVolumeFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureVolumeFollowParams(params);
        const lookback = p.lookback as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [volumePercentile], (i) => {
            const volPct = volumePercentile[i];
            if (volPct === null) return null;

            const pr = cleanPressure[i];
            if (volPct > volumePercentileMin) {
                if (pr > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish initiative pressure ${pr.toFixed(2)} confirmed by volume percentile ${volPct.toFixed(2)}`
                    );
                }
                if (pr < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish initiative pressure ${pr.toFixed(2)} confirmed by volume percentile ${volPct.toFixed(2)}`
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
