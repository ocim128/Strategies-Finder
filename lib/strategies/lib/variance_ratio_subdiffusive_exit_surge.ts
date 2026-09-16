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
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 28))),
    };
}

export const variance_ratio_subdiffusive_exit_surge: Strategy = {
    name: "Variance Ratio Subdiffusive Exit Surge",
    description: "Enters early breakout when Variance Ratio crosses above 0.85 from subdiffusive anti-persistent chop.",
    defaultParams: {
        lookback: 28,
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

        return createSignalLoop(cleanData, [vr], (i) => {
            if (i < 4) return null;
            const vPrev = vr[i - 1];
            const vCurr = vr[i];
            if (vPrev === null || vCurr === null) return null;

            if (vPrev <= 0.85 && vCurr > 0.85) {
                if (closes[i] > closes[i - 4]) {
                    return createBuySignal(cleanData, i, `Bullish subdiffusive exit surge: VR crossed 0.85 (${vPrev.toFixed(2)} -> ${vCurr.toFixed(2)}), close > close[i-4]`);
                }
                if (closes[i] < closes[i - 4]) {
                    return createSellSignal(cleanData, i, `Bearish subdiffusive exit surge: VR crossed 0.85 (${vPrev.toFixed(2)} -> ${vCurr.toFixed(2)}), close < close[i-4]`);
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
