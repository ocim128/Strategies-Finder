import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeChannelPierceReclaimFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const channel_pierce_reclaim_fade: Strategy = {
    name: "Channel Pierce Reclaim Fade",
    description: "Fades bars that pierce the prior-only trailing channel edge but close back inside the channel.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeChannelPierceReclaimFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeChannelPierceReclaimFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const channel = buildTrailingHighLow(cleanData, lookback, false);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const lowest = channel.lowest[i];
            const highest = channel.highest[i];
            if (lowest === null || highest === null) return null;

            if (cleanData[i].low < lowest && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Down-pierce of trailing low ${lowest.toFixed(4)} reclaimed at close location ${closeLocation[i].toFixed(2)}`);
            }
            if (cleanData[i].high > highest && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `Up-pierce of trailing high ${highest.toFixed(4)} rejected at close location ${closeLocation[i].toFixed(2)}`);
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
