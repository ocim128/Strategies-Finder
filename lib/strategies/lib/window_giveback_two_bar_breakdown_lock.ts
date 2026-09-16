import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildWindowGivebackRatio } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 28))),
    };
}

export const window_giveback_two_bar_breakdown_lock: Strategy = {
    name: "Window Giveback Two-Bar Breakdown Lock",
    description: "Enters reversal liquidation cascade when giveback ratio remains strictly greater than 0.618 across two consecutive bars.",
    defaultParams: {
        lookback: 28,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);
        const closes = getCloses(cleanData);

        const gb = buildWindowGivebackRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback + 2) return null;
            const g0 = gb[i];
            const g1 = gb[i - 1];
            if (g0 === null || g1 === null) return null;

            if (g1 > 0.618 && g0 > 0.618) {
                if (closes[i - 2] < closes[i - 2 - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish two-bar fib breakdown lock: consecutive giveback ${g1.toFixed(2)} and ${g0.toFixed(2)} > 0.618 reversing down-window`);
                }
                if (closes[i - 2] >= closes[i - 2 - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish two-bar fib breakdown lock: consecutive giveback ${g1.toFixed(2)} and ${g0.toFixed(2)} > 0.618 reversing up-window`);
                }
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
