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
        velocity_threshold: Math.max(0.01, Number(params.velocity_threshold ?? 0.25)),
    };
}

export const window_giveback_acceleration_thrust: Strategy = {
    name: "Window Giveback Acceleration Thrust",
    description: "Trades trend acceleration when negative giveback velocity reveals rapid pullback collapse back into the prevailing trend.",
    defaultParams: {
        velocity_threshold: 0.25,
    },
    paramLabels: {
        velocity_threshold: "Velocity Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const velocity_threshold = p.velocity_threshold as number;
        if (cleanData.length < 20 + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, 20);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 20) return null;
            const prevGb = gb[i - 1];
            const currGb = gb[i];
            if (prevGb === null || currGb === null) return null;

            const deltaGb = currGb - prevGb;
            if (deltaGb <= -velocity_threshold) {
                if (closes[i] > closes[i - 20]) {
                    return createBuySignal(cleanData, i, `Bullish giveback acceleration: delta giveback ${deltaGb.toFixed(3)} <= -${velocity_threshold}, up-window`);
                }
                if (closes[i] < closes[i - 20]) {
                    return createSellSignal(cleanData, i, `Bearish giveback acceleration: delta giveback ${deltaGb.toFixed(3)} <= -${velocity_threshold}, down-window`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["velocity_threshold"],
    },
};
