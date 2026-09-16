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
        down_giveback_threshold: Math.max(0.01, Math.min(0.49, Number(params.down_giveback_threshold ?? 0.25))),
    };
}

export const window_giveback_directional_asymmetry: Strategy = {
    name: "Window Giveback Directional Asymmetry",
    description: "Trades asymmetric giveback elasticity: fast elastic snapback on down-window retracement vs deeper threshold on up-window.",
    defaultParams: {
        down_giveback_threshold: 0.25,
    },
    paramLabels: {
        down_giveback_threshold: "Down Giveback Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const downThreshold = p.down_giveback_threshold as number;
        const upThreshold = downThreshold * 2.0;
        if (cleanData.length < 26) return [];

        const gb = buildWindowGivebackRatio(cleanData, 24);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 24) return null;
            const currentGb = gb[i];
            const prevGb = gb[i - 1];
            if (currentGb === null || prevGb === null) return null;

            // Down-window: fast elastic snapback when giveback crosses above down_giveback_threshold
            if (closes[i] < closes[i - 24] && prevGb <= downThreshold && currentGb > downThreshold) {
                return createBuySignal(cleanData, i, `Bullish down-window snapback: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} > ${downThreshold}`);
            }

            // Up-window: deeper tolerance, sell breakdown when giveback surrenders 2x threshold
            if (closes[i] >= closes[i - 24] && prevGb <= upThreshold && currentGb > upThreshold) {
                return createSellSignal(cleanData, i, `Bearish up-window breakdown: giveback ${prevGb.toFixed(3)} -> ${currentGb.toFixed(3)} > ${upThreshold}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["down_giveback_threshold"],
    },
};
