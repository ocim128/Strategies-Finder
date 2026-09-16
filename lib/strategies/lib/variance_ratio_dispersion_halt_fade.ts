import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay_threshold: Math.max(0.01, Number(params.decay_threshold ?? 0.2)),
    };
}

export const variance_ratio_dispersion_halt_fade: Strategy = {
    name: "Variance Ratio Dispersion Halt Fade",
    description: "Fades boundary closing locations when 1-bar variance ratio velocity drops sharply, signaling sudden dispersion collapse.",
    defaultParams: {
        decay_threshold: 0.2,
    },
    paramLabels: {
        decay_threshold: "Decay Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const decay_threshold = p.decay_threshold as number;
        if (cleanData.length < 24 + 4 + 1) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 24, 4);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vr, clsLoc], (i) => {
            if (i < 1) return null;
            const vPrev = vr[i - 1];
            const vCurr = vr[i];
            const loc = clsLoc[i];
            if (vPrev === null || vCurr === null || loc === null) return null;

            const deltaVr = vCurr - vPrev;
            if (deltaVr <= -decay_threshold) {
                if (loc <= 0.20) {
                    return createBuySignal(cleanData, i, `Bullish dispersion halt fade: delta VR ${deltaVr.toFixed(3)} <= -${decay_threshold}, close location ${loc.toFixed(3)} <= 0.20`);
                }
                if (loc >= 0.80) {
                    return createSellSignal(cleanData, i, `Bearish dispersion halt fade: delta VR ${deltaVr.toFixed(3)} <= -${decay_threshold}, close location ${loc.toFixed(3)} >= 0.80`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay_threshold"],
    },
};
