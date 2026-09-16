import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildVarianceRatio } from "./price-action-statistics-core";
import {
    buildRangeSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const variance_ratio_stealth_drift_continuation: Strategy = {
    name: "Variance Ratio Stealth Drift Continuation",
    description: "Captures low-volatility stealth trend continuation when the Variance Ratio confirms superdiffusion while bar range is compressed.",
    defaultParams: {
        lookback: 24,
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
        const range = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(range, lookback);

        return createSignalLoop(cleanData, [vr, range, avgRange], (i) => {
            if (i < lookback) return null;
            const v = vr[i];
            const r = range[i];
            const avgR = avgRange[i];
            if (v === null || r === null || avgR === null) return null;

            if (v >= 1.10 && r < avgR * 0.60) {
                if (cleanData[i].close > cleanData[i].open && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish stealth drift: VR ${v.toFixed(3)} >= 1.10, range ${r.toFixed(3)} < 0.60 * avg ${avgR.toFixed(3)}, bull close > close[i-${lookback}]`);
                }
                if (cleanData[i].close < cleanData[i].open && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish stealth drift: VR ${v.toFixed(3)} >= 1.10, range ${r.toFixed(3)} < 0.60 * avg ${avgR.toFixed(3)}, bear close < close[i-${lookback}]`);
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
