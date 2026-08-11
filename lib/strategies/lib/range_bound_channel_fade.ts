import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";

const WIDTH_ATR_CAP = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const range_bound_channel_fade: Strategy = {
    name: "Range Bound Channel Fade",
    description: "Fades prior-only channel edge touches only when the channel is narrow relative to ATR, proving a range-bound regime.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < lookback) return null;
            const atrNow = atr[i];
            const high = highest[i];
            const low = lowest[i];
            if (atrNow === null || atrNow <= 0 || high === null || low === null) return null;

            const width = high - low;
            if (width <= WIDTH_ATR_CAP * atrNow && closes[i] <= low) {
                return createBuySignal(cleanData, i, `Range floor fade buy: close ${closes[i].toFixed(4)} at prior-only low ${low.toFixed(4)}`);
            }
            if (width <= WIDTH_ATR_CAP * atrNow && closes[i] >= high) {
                return createSellSignal(cleanData, i, `Range ceiling fade sell: close ${closes[i].toFixed(4)} at prior-only high ${high.toFixed(4)}`);
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
