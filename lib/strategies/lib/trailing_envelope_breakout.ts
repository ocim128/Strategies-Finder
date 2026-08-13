import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingHighLow } from "./price-action-frequency-core";

const ACCEPTANCE_GATE = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const trailing_envelope_breakout: Strategy = {
    name: "Trailing Envelope Breakout",
    description: "Breaks the prior-only trailing high/low envelope only when the close earns the new territory.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Envelope Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        // Prior-only envelope: the reference excludes the current bar.
        const trailing = buildTrailingHighLow(cleanData, lookback, false);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [trailing.highest, trailing.lowest], (i) => {
            const high = trailing.highest[i];
            const low = trailing.lowest[i];
            if (high === null || low === null) return null;

            if (cleanData[i].close > high && acceptance[i] >= ACCEPTANCE_GATE) {
                return createBuySignal(cleanData, i, `Earned breakout above trailing high: acceptance ${acceptance[i].toFixed(2)}`);
            }
            if (cleanData[i].close < low && acceptance[i] <= -ACCEPTANCE_GATE) {
                return createSellSignal(cleanData, i, `Earned breakout below trailing low: acceptance ${acceptance[i].toFixed(2)}`);
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
