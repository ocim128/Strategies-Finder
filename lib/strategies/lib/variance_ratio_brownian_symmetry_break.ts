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
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const variance_ratio_brownian_symmetry_break: Strategy = {
    name: "Variance Ratio Brownian Symmetry Break",
    description: "Enters directional breakouts when multi-horizon variance ratios (VR2 and VR8) converge into pure Brownian diffusive symmetry.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 8) return [];

        const closes = getCloses(cleanData);
        const vr2 = buildVarianceRatio(closes, lookback, 2);
        const vr8 = buildVarianceRatio(closes, lookback, 8);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vr2, vr8, clsLoc], (i) => {
            const v2 = vr2[i];
            const v8 = vr8[i];
            const loc = clsLoc[i];
            if (v2 === null || v8 === null || loc === null) return null;

            const isBrownianSymmetry = v2 >= 0.95 && v2 <= 1.05 && v8 >= 0.95 && v8 <= 1.05;
            if (isBrownianSymmetry) {
                if (loc >= 0.85) {
                    return createBuySignal(cleanData, i, `Bullish Brownian symmetry break: VR(2) ${v2.toFixed(3)} and VR(8) ${v8.toFixed(3)} in [0.95, 1.05], close location ${loc.toFixed(3)} >= 0.85`);
                }
                if (loc <= 0.15) {
                    return createSellSignal(cleanData, i, `Bearish Brownian symmetry break: VR(2) ${v2.toFixed(3)} and VR(8) ${v8.toFixed(3)} in [0.95, 1.05], close location ${loc.toFixed(3)} <= 0.15`);
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
