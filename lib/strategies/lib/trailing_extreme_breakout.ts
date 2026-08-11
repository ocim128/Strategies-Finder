import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 55))),
    };
}

export const trailing_extreme_breakout: Strategy = {
    name: "Trailing Extreme Breakout",
    description: "Enters when the close breaks beyond the prior-only trailing high or low of the lookback window.",
    defaultParams: {
        lookback: 55,
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

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const high = highest[i];
            const low = lowest[i];
            const prevHigh = highest[i - 1];
            const prevLow = lowest[i - 1];
            if (high === null || low === null || prevHigh === null || prevLow === null) return null;

            // Fresh close beyond the prior window's high, not a continuation.
            if (closes[i] > high && closes[i - 1] <= prevHigh) {
                return createBuySignal(cleanData, i, `Trailing breakout buy: close ${closes[i].toFixed(4)} above prior high ${high.toFixed(4)}`);
            }
            // Fresh close beyond the prior window's low.
            if (closes[i] < low && closes[i - 1] >= prevLow) {
                return createSellSignal(cleanData, i, `Trailing breakout sell: close ${closes[i].toFixed(4)} below prior low ${low.toFixed(4)}`);
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
