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
        threshold: Math.max(0.01, Number(params.threshold ?? 0.20)),
    };
}

export const variance_ratio_multi_bar_slope_surge: Strategy = {
    name: "Variance Ratio Multi-Bar Slope Surge",
    description: "Enters trend expansion when the 2-bar change in Variance Ratio increases by at least threshold.",
    defaultParams: {
        threshold: 0.20,
    },
    paramLabels: {
        threshold: "VR Slope Threshold",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const threshold = Number(params.threshold);
        const closes = getCloses(cleanData);

        const vr = buildVarianceRatio(closes, 24, 4);

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 2) return null;
            const vPrev = vr[i - 2];
            const vCurr = vr[i];
            if (vPrev === null || vCurr === null) return null;

            if (vCurr - vPrev >= threshold) {
                if (closes[i] > closes[i - 2]) {
                    return createBuySignal(cleanData, i, `Bullish VR multi-bar slope surge: 2-bar delta ${(vCurr - vPrev).toFixed(3)} >= ${threshold}, close > close[i-2]`);
                }
                if (closes[i] < closes[i - 2]) {
                    return createSellSignal(cleanData, i, `Bearish VR multi-bar slope surge: 2-bar delta ${(vCurr - vPrev).toFixed(3)} >= ${threshold}, close < close[i-2]`);
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
