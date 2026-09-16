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
        threshold: Math.max(0.001, Number(params.threshold ?? 0.25)),
    };
}

export const variance_ratio_inverted_term_fade: Strategy = {
    name: "Variance Ratio Inverted Term Fade",
    description: "Fades transitory short-term variance bursts when the inverted Variance Ratio term structure (VR2 - VR8) expands.",
    defaultParams: {
        threshold: 0.25,
    },
    paramLabels: {
        threshold: "Inversion Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.threshold as number;
        if (cleanData.length < 30 + 8) return [];

        const closes = getCloses(cleanData);
        const vr2 = buildVarianceRatio(closes, 30, 2);
        const vr8 = buildVarianceRatio(closes, 30, 8);

        return createSignalLoop(cleanData, [vr2, vr8], (i) => {
            if (i < 2) return null;
            const v2 = vr2[i];
            const v8 = vr8[i];
            if (v2 === null || v8 === null) return null;

            const diff = v2 - v8;
            if (diff >= threshold) {
                if (closes[i] < closes[i - 2]) {
                    return createBuySignal(cleanData, i, `Bullish inverted VR term fade: VR(2)-VR(8) ${diff.toFixed(3)} >= ${threshold}, down-spike close < close[i-2]`);
                }
                if (closes[i] > closes[i - 2]) {
                    return createSellSignal(cleanData, i, `Bearish inverted VR term fade: VR(2)-VR(8) ${diff.toFixed(3)} >= ${threshold}, up-spike close > close[i-2]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["threshold"],
    },
};
