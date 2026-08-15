import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeTrailingBoundaryProbeRejectionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const trailing_boundary_probe_rejection: Strategy = {
    name: "Trailing Boundary Probe Rejection",
    description: "Fades wicks that penetrate the prior-only trailing high/low when the close snaps back inside, reading a rejected probe.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeTrailingBoundaryProbeRejectionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeTrailingBoundaryProbeRejectionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [highest, lowest], (i) => {
            if (i < lookback) return null;
            const highBound = highest[i];
            const lowBound = lowest[i];
            if (highBound === null || lowBound === null) return null;
            const bar = cleanData[i];

            if (bar.low < lowBound && bar.close > lowBound) {
                return createBuySignal(cleanData, i, "Probe rejection buy: low pierced trailing low, close recovered");
            }
            if (bar.high > highBound && bar.close < highBound) {
                return createSellSignal(cleanData, i, "Probe rejection sell: high pierced trailing high, close rejected");
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
