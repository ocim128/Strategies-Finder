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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const window_giveback_fib_failure: Strategy = {
    name: "Window Giveback Fib Failure",
    description: "Fades a broken trend upon crossing 0.618 excursion giveback, entering counter-trend liquidation cascades.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gb = buildWindowGivebackRatio(cleanData, lookback);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback + 1) return null;
            const currentGb = gb[i];
            const prevGb = gb[i - 1];
            if (currentGb === null || prevGb === null) return null;

            if (prevGb <= 0.618 && currentGb > 0.618) {
                // Prior window was down-trend, gave back > 61.8% -> buy reversal
                if (closes[i - 1] < closes[i - 1 - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish Fib failure: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} > 0.618 in down-window`);
                }
                // Prior window was up-trend, gave back > 61.8% -> sell reversal
                if (closes[i - 1] >= closes[i - 1 - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish Fib failure: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} > 0.618 in up-window`);
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
