import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        vr_ceiling: Math.max(0.01, Number(params.vr_ceiling ?? 0.75)),
    };
}

export const variance_ratio_anti_persistence_trap_fade: Strategy = {
    name: "Variance Ratio Anti-Persistence Trap Fade",
    description: "Fades breakout attempts beyond prior bar extremes when the Variance Ratio confirms a deeply subdiffusive trap regime.",
    defaultParams: {
        vr_ceiling: 0.75,
    },
    paramLabels: {
        vr_ceiling: "Max Subdiffusive Ceiling",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const vr_ceiling = p.vr_ceiling as number;
        if (cleanData.length < 30 + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 30, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 1) return null;
            const v = vr[i];
            if (v === null || v > vr_ceiling) return null;

            if (cleanData[i].close < cleanData[i - 1].low) {
                return createBuySignal(cleanData, i, `Bullish anti-persistence trap fade: VR ${v.toFixed(3)} <= ${vr_ceiling}, breakdown close < prior low`);
            }
            if (cleanData[i].close > cleanData[i - 1].high) {
                return createSellSignal(cleanData, i, `Bearish anti-persistence trap fade: VR ${v.toFixed(3)} <= ${vr_ceiling}, breakout close > prior high`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["vr_ceiling"],
    },
};
