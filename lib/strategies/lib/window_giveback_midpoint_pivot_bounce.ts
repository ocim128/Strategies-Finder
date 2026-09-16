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

export const window_giveback_midpoint_pivot_bounce: Strategy = {
    name: "Window Giveback Midpoint Pivot Bounce",
    description: "Enters trend continuation when excursion giveback recovers below 0.45 after testing the 0.500 equilibrium midpoint pivot.",
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
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < lookback) return null;
            const prevGb = gb[i - 1];
            const currGb = gb[i];
            if (prevGb === null || currGb === null) return null;

            if (prevGb >= 0.45 && prevGb <= 0.55 && currGb < 0.45) {
                if (closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish midpoint bounce: giveback recovered from ${prevGb.toFixed(3)} to ${currGb.toFixed(3)} < 0.45, up-window`);
                }
                if (closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish midpoint bounce: giveback recovered from ${prevGb.toFixed(3)} to ${currGb.toFixed(3)} < 0.45, down-window`);
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
