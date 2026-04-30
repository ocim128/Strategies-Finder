import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

function normalizeFractalEfficiencyRegimeAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 63)),
        threshold: Math.max(0, Math.min(1, Number(params.threshold ?? 0.3))),
    };
}

export const fractal_efficiency_regime_alignment: Strategy = {
    name: "Fractal Efficiency Regime Alignment",
    description:
        "Quantifies path straightness with a Kaufman-style efficiency ratio and only aligns with the rolling median when price action is directional rather than noisy.",
    defaultParams: {
        lookback: 63,
        threshold: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Efficiency Threshold",
    },
    normalizeParams: normalizeFractalEfficiencyRegimeAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeFractalEfficiencyRegimeAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, median], (i) => {
            if (i < lookback) return null;

            const er = efficiency[i];
            const med = median[i];
            if (er === null || med === null || er <= (p.threshold as number)) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Efficiency ${er.toFixed(3)} above threshold with close above median`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Efficiency ${er.toFixed(3)} above threshold with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
