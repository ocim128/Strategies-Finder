import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 36))),
    };
}

export const variance_ratio_subdiffusive_fade: Strategy = {
    name: "Variance Ratio Subdiffusive Fade",
    description: "Fades extreme bar close locations in strongly subdiffusive regimes (VR < 0.70).",
    defaultParams: {
        lookback: 36,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, lookback, 4);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vr, closeLocation], (i) => {
            const currentVr = vr[i];
            const cl = closeLocation[i];
            if (currentVr === null || cl === null) return null;

            if (currentVr < 0.70) {
                if (cl <= 0.25) {
                    return createBuySignal(cleanData, i, `Bullish subdiffusive fade: VR ${currentVr.toFixed(3)} < 0.70, closeLocation ${cl.toFixed(2)} <= 0.25`);
                }
                if (cl >= 0.75) {
                    return createSellSignal(cleanData, i, `Bearish subdiffusive fade: VR ${currentVr.toFixed(3)} < 0.70, closeLocation ${cl.toFixed(2)} >= 0.75`);
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
