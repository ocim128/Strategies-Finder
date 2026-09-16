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
        min_vr: Math.max(0.01, Number(params.min_vr ?? 0.55)),
    };
}

export const variance_ratio_subdiffusive_floor_rubberband: Strategy = {
    name: "Variance Ratio Subdiffusive Floor Rubberband",
    description: "Fades multi-bar return excursions when the Variance Ratio hits an extreme subdiffusive floor.",
    defaultParams: {
        min_vr: 0.55,
    },
    paramLabels: {
        min_vr: "Min Variance Ratio Floor",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const min_vr = p.min_vr as number;
        if (cleanData.length < 30 + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 30, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 4) return null;
            const v = vr[i];
            if (v === null) return null;

            if (v <= min_vr) {
                if (closes[i] < closes[i - 4]) {
                    return createBuySignal(cleanData, i, `Bullish floor rubberband: VR ${v.toFixed(3)} <= ${min_vr}, 4-bar return negative`);
                }
                if (closes[i] > closes[i - 4]) {
                    return createSellSignal(cleanData, i, `Bearish floor rubberband: VR ${v.toFixed(3)} <= ${min_vr}, 4-bar return positive`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_vr"],
    },
};
