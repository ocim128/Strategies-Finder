import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildEfficiencyRatio,
    buildVarianceRatio,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        efficiency_threshold: Math.max(0.01, Math.min(1, Number(params.efficiency_threshold ?? 0.6))),
    };
}

export const variance_ratio_efficiency_orthogonal_router: Strategy = {
    name: "Variance Ratio Efficiency Orthogonal Router",
    description: "Combines 2nd-moment variance scaling (VR >= 1.10) with 1st-moment Kaufman path efficiency.",
    defaultParams: {
        efficiency_threshold: 0.6,
    },
    paramLabels: {
        efficiency_threshold: "Efficiency Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.efficiency_threshold as number;
        if (cleanData.length < 34) return [];

        const closes = getCloses(cleanData);
        const vr = buildVarianceRatio(closes, 30, 4);
        const eff = buildEfficiencyRatio(cleanData, 12);

        return createSignalLoop(cleanData, [vr, eff], (i) => {
            if (i < 12) return null;
            const currentVr = vr[i];
            const currentEff = eff[i];
            if (currentVr === null || currentEff === null) return null;

            if (currentVr >= 1.10 && currentEff >= threshold) {
                if (closes[i] > closes[i - 12]) {
                    return createBuySignal(cleanData, i, `Bullish orthogonal momentum: VR ${currentVr.toFixed(3)} >= 1.10, ER ${currentEff.toFixed(2)} >= ${threshold}, close > close[i-12]`);
                }
                if (closes[i] < closes[i - 12]) {
                    return createSellSignal(cleanData, i, `Bearish orthogonal momentum: VR ${currentVr.toFixed(3)} >= 1.10, ER ${currentEff.toFixed(2)} >= ${threshold}, close < close[i-12]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["efficiency_threshold"],
    },
};
