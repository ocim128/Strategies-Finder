import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const VOLUME_PARTICIPATION_BAND = 0.8;

function normalizeVolumeConfirmedBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_confirmed_breakout: Strategy = {
    name: "Volume Confirmed Breakout",
    description: "Follows closes beyond the prior-only trailing high/low only when the break bar's volume proxy sits at a high percentile of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeConfirmedBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeVolumeConfirmedBreakoutParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const volumePct = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [highest, lowest, volumePct], (i) => {
            if (i < lookback) return null;
            const highBound = highest[i];
            const lowBound = lowest[i];
            const volRank = volumePct[i];
            if (highBound === null || lowBound === null || volRank === null) return null;
            const close = cleanData[i].close;

            if (close > highBound && volRank > VOLUME_PARTICIPATION_BAND) {
                return createBuySignal(cleanData, i, `Volume confirmed breakout buy: close above trailing high, volume rank ${volRank.toFixed(2)}`);
            }
            if (close < lowBound && volRank > VOLUME_PARTICIPATION_BAND) {
                return createSellSignal(cleanData, i, `Volume confirmed breakout sell: close below trailing low, volume rank ${volRank.toFixed(2)}`);
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
