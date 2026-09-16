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
        velocity_threshold: Math.max(0.001, Number(params.velocity_threshold ?? 0.3)),
    };
}

export const window_giveback_velocity_capitulation: Strategy = {
    name: "Window Giveback Velocity Capitulation",
    description: "Fades acute single-bar liquidation panic surges in excursion giveback within prevailing trends.",
    defaultParams: {
        velocity_threshold: 0.3,
    },
    paramLabels: {
        velocity_threshold: "Velocity Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.velocity_threshold as number;
        if (cleanData.length < 21) return [];

        const gb = buildWindowGivebackRatio(cleanData, 20);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 20) return null;
            const currentGb = gb[i];
            const prevGb = gb[i - 1];
            if (currentGb === null || prevGb === null) return null;

            const deltaGb = currentGb - prevGb;
            if (deltaGb >= threshold) {
                // Up-window panic flush: surge in giveback indicates panic drop in prevailing uptrend -> buy elastic dip
                if (closes[i] >= closes[i - 20]) {
                    return createBuySignal(cleanData, i, `Bullish giveback capitulation fade: delta gb ${deltaGb.toFixed(3)} >= ${threshold} in up-window`);
                }
                // Down-window panic squeeze: surge in giveback indicates short-covering rip in prevailing downtrend -> sell elastic pop
                if (closes[i] < closes[i - 20]) {
                    return createSellSignal(cleanData, i, `Bearish giveback capitulation fade: delta gb ${deltaGb.toFixed(3)} >= ${threshold} in down-window`);
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
