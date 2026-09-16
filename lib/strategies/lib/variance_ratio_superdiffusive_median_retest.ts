import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingMedian,
    buildVarianceRatio,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 24))),
    };
}

export const variance_ratio_superdiffusive_median_retest: Strategy = {
    name: "Variance Ratio Superdiffusive Median Retest",
    description: "Buys/sells rolling median retests when price touches and holds the rolling median during a certified superdiffusive trend.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);
        const closes = getCloses(cleanData);

        const vr = buildVarianceRatio(closes, lookback, 4);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [vr, median], (i) => {
            if (i < lookback) return null;
            const v = vr[i];
            const m = median[i];
            if (v === null || m === null) return null;

            if (v >= 1.20) {
                if (cleanData[i].low <= m && cleanData[i].close > m && closes[i] > closes[i - lookback]) {
                    return createBuySignal(cleanData, i, `Bullish superdiffusive median retest: VR=${v.toFixed(2)}>=1.20, low<=median, close>median, up-trend`);
                }
                if (cleanData[i].high >= m && cleanData[i].close < m && closes[i] < closes[i - lookback]) {
                    return createSellSignal(cleanData, i, `Bearish superdiffusive median retest: VR=${v.toFixed(2)}>=1.20, high>=median, close<median, down-trend`);
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
