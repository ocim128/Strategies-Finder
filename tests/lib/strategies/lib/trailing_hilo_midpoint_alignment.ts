import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingHiloMidpointAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const trailing_hilo_midpoint_alignment: Strategy = {
    name: "Trailing Hilo Midpoint Alignment",
    description:
        "Uses the midpoint of the trailing highest high and lowest low as a pure range-derived value anchor and aligns entries by whether the daily close settles above or below it.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTrailingHiloMidpointAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingHiloMidpointAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            const hi = highest[i];
            const lo = lowest[i];
            if (hi === null || lo === null) return null;

            const midpoint = (hi + lo) / 2;
            if (closes[i] > midpoint) {
                return createBuySignal(cleanData, i, `Close above trailing hi/lo midpoint ${midpoint.toFixed(2)}`);
            }
            if (closes[i] < midpoint) {
                return createSellSignal(cleanData, i, `Close below trailing hi/lo midpoint ${midpoint.toFixed(2)}`);
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
