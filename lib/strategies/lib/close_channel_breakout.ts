import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingMinMax } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const close_channel_breakout: Strategy = {
    name: "Close Channel Breakout",
    description: "Continues when the close breaks the prior-only trailing close channel with same-sign lookback momentum.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Channel Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const closes = getCloses(cleanData);
        const channel = buildRollingMinMax(closes, lookback, false);
        const momentum = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [channel.max, channel.min, momentum], (i) => {
            const channelHigh = channel.max[i];
            const channelLow = channel.min[i];
            const roc = momentum[i];
            if (channelHigh === null || channelLow === null || roc === null) return null;

            if (closes[i] > channelHigh && roc > 0) {
                return createBuySignal(cleanData, i, "Close broke channel high with momentum");
            }
            if (closes[i] < channelLow && roc < 0) {
                return createSellSignal(cleanData, i, "Close broke channel low with momentum");
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
