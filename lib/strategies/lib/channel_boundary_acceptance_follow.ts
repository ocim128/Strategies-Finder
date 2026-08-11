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

export const channel_boundary_acceptance_follow: Strategy = {
    name: "Channel Boundary Acceptance Follow",
    description: "Follows breakouts where the bar's close, not just its wick, settles beyond the prior-only trailing channel.",
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

            // Poked beyond the prior-window high AND settled there: acceptance.
            if (cleanData[i].high >= hi && cleanData[i].close >= hi) {
                return createBuySignal(cleanData, i, `Channel acceptance buy: close ${cleanData[i].close.toFixed(4)} settled beyond ${hi.toFixed(4)}`);
            }
            if (cleanData[i].low <= lo && cleanData[i].close <= lo) {
                return createSellSignal(cleanData, i, `Channel acceptance sell: close ${cleanData[i].close.toFixed(4)} settled beyond ${lo.toFixed(4)}`);
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
