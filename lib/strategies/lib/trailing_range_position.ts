import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingRangePositionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    };
}

export const trailing_range_position: Strategy = {
    name: "Trailing Range Position",
    description: "Where the close sits inside the trailing high-low span reveals directional acceptance. Upper-half closes imply buyers are defending higher territory; lower-half closes imply the opposite.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTrailingRangePositionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingRangePositionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            const hi = highest[i];
            const lo = lowest[i];
            if (hi === null || lo === null) return null;

            const span = hi - lo;
            if (span <= 0) return null;
            const position = (closes[i] - lo) / span;

            if (position > 0.5) {
                return createBuySignal(cleanData, i, `Close in upper half of trailing range (${(position * 100).toFixed(1)}%)`);
            }
            if (position < 0.5) {
                return createSellSignal(cleanData, i, `Close in lower half of trailing range (${(position * 100).toFixed(1)}%)`);
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
