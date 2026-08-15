import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

const ACCELERATION_DELTA_BAND = 0.2;

function normalizeVolumeAccelerationConfirmationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_acceleration_confirmation: Strategy = {
    name: "Volume Acceleration Confirmation",
    description: "Confirms the bar's direction when the volume proxy's percentile jumps from the prior bar.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeAccelerationConfirmationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeVolumeAccelerationConfirmationParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const volumePct = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [volumePct], (i) => {
            if (i < lookback) return null;
            const volRankNow = volumePct[i];
            const volRankPrev = volumePct[i - 1];
            if (volRankNow === null || volRankPrev === null) return null;
            const bar = cleanData[i];
            const delta = volRankNow - volRankPrev;

            if (delta > ACCELERATION_DELTA_BAND && bar.close > bar.open) {
                return createBuySignal(cleanData, i, `Volume acceleration buy: volume rank +${delta.toFixed(2)} with bullish close`);
            }
            if (delta > ACCELERATION_DELTA_BAND && bar.close < bar.open) {
                return createSellSignal(cleanData, i, `Volume acceleration sell: volume rank +${delta.toFixed(2)} with bearish close`);
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
