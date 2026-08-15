import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";

const UPPER_ACCEPTANCE = 0.7;
const LOWER_ACCEPTANCE = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const trailing_breakout_acceptance: Strategy = {
    name: "Trailing Breakout Acceptance",
    description: "Continues a close beyond the prior-only trailing boundary only when the breakout bar closes in its far range.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Boundary Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            const boundaryHigh = highest[i];
            const boundaryLow = lowest[i];
            if (boundaryHigh === null || boundaryLow === null) return null;

            const bar = cleanData[i];
            if (bar.close > boundaryHigh && closeLocation[i] > UPPER_ACCEPTANCE) {
                return createBuySignal(cleanData, i, "Accepted break above trailing high");
            }
            if (bar.close < boundaryLow && closeLocation[i] < LOWER_ACCEPTANCE) {
                return createSellSignal(cleanData, i, "Accepted break below trailing low");
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
