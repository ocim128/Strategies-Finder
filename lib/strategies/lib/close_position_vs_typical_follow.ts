import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getTypicalPrices, getVolumes } from "../strategy-helpers";
import { buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeClosePositionVsTypicalFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        deviationMin: Math.max(0, Number(params.deviationMin ?? 0.10)),
        volumePercentileMin: Math.max(0, Math.min(1, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const close_position_vs_typical_follow: Strategy = {
    name: "Close Position fair value fair Typical Follow",
    description: "Close position relative to typical price as order flow signal.",
    defaultParams: {
        lookback: 25,
        deviationMin: 0.10,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        deviationMin: "Deviation Min",
        volumePercentileMin: "Volume Percentile Min",
    },
    normalizeParams: normalizeClosePositionVsTypicalFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeClosePositionVsTypicalFollowParams(params);
        const lookback = p.lookback as number;
        const deviationMin = p.deviationMin as number;
        const volumePercentileMin = p.volumePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const typicalPrices = getTypicalPrices(cleanData);
        const ranges = buildRangeSeries(cleanData);

        const deviation: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const range = ranges[i];
            deviation[i] = range > 0 ? (closes[i] - typicalPrices[i]) / range : 0;
        }

        const smoothedDeviation = buildRollingAverage(deviation, lookback);
        const volumes = getVolumes(cleanData);
        const volumePercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [smoothedDeviation, volumePercentile], (i) => {
            const dev = smoothedDeviation[i];
            const volPct = volumePercentile[i];
            if (dev === null || volPct === null) return null;

            if (volPct > volumePercentileMin) {
                if (dev > deviationMin) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Close-to-typical deviation ${dev.toFixed(3)} above threshold ${deviationMin} (buying flow)`
                    );
                }
                if (dev < -deviationMin) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Close-to-typical deviation ${dev.toFixed(3)} below threshold -${deviationMin} (selling flow)`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deviationMin", "volumePercentileMin"],
    },
};
