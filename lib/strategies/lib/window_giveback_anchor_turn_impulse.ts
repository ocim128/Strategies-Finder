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
        max_giveback: Math.max(0.1, Math.min(1, Number(params.max_giveback ?? 0.85))),
    };
}

export const window_giveback_anchor_turn_impulse: Strategy = {
    name: "Window Giveback Anchor Turn Impulse",
    description: "Catches early V-reversals when excursion giveback contracts by at least 0.15 after reaching an extreme 85%+ surrender.",
    defaultParams: {
        max_giveback: 0.85,
    },
    paramLabels: {
        max_giveback: "Max Surrender Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const max_giveback = p.max_giveback as number;
        if (cleanData.length < 24 + 1) return [];

        const closes = getCloses(cleanData);
        const gb = buildWindowGivebackRatio(cleanData, 24);

        return createSignalLoop(cleanData, [gb], (i) => {
            if (i < 24) return null;
            const prevGb = gb[i - 1];
            const currGb = gb[i];
            if (prevGb === null || currGb === null) return null;

            if (prevGb >= max_giveback && currGb <= prevGb - 0.15) {
                if (closes[i] >= closes[i - 24]) {
                    return createBuySignal(cleanData, i, `Bullish anchor turn impulse: prior giveback ${prevGb.toFixed(3)} >= ${max_giveback}, contracted to ${currGb.toFixed(3)}, up-window`);
                }
                if (closes[i] < closes[i - 24]) {
                    return createSellSignal(cleanData, i, `Bearish anchor turn impulse: prior giveback ${prevGb.toFixed(3)} >= ${max_giveback}, contracted to ${currGb.toFixed(3)}, down-window`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_giveback"],
    },
};
