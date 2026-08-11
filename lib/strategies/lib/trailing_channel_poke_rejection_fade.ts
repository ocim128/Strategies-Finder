import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const trailing_channel_poke_rejection_fade: Strategy = {
    name: "Trailing Channel Poke Rejection Fade",
    description: "Fades pokes beyond the prior-only trailing channel that the close rejects back inside: the multi-bar boundary holds.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Channel Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            const hi = highest[i];
            const lo = lowest[i];
            if (hi === null || lo === null) return null;

            // Poked below the prior channel low but closed back inside: failed breakdown.
            if (cleanData[i].low < lo && cleanData[i].close > lo) {
                return createBuySignal(cleanData, i, `Poke rejection buy: low ${cleanData[i].low.toFixed(4)} poked ${lo.toFixed(4)}, close ${cleanData[i].close.toFixed(4)} held`);
            }
            if (cleanData[i].high > hi && cleanData[i].close < hi) {
                return createSellSignal(cleanData, i, `Poke rejection sell: high ${cleanData[i].high.toFixed(4)} poked ${hi.toFixed(4)}, close ${cleanData[i].close.toFixed(4)} held`);
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
