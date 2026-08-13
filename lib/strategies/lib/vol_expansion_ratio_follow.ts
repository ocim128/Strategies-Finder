import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingStdDev, extractBarMetricSeries } from "./price-action-statistics-core";

const FAST_SLOW_RATIO = 3;
// The short window is a fixed 1/3 of the long window and the short window is
// always contained in the long window, so the ratio shortVol/longVol is
// mathematically bounded by sqrt(3) ~= 1.73. A gate at 1.8 (as originally
// drafted) could never fire; 1.5 keeps the "strong expansion" intent reachable.
const EXPANSION_RATIO_GATE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(6, Math.round(Number(params.lookback ?? 60))),
    };
}

export const vol_expansion_ratio_follow: Strategy = {
    name: "Volatility Expansion Ratio",
    description: "Follows the expansion bar when short-window return volatility jumps relative to its long baseline.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Baseline Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const shortWindow = Math.max(2, Math.round(lookback / FAST_SLOW_RATIO));
        const shortVol = buildRollingStdDev(returns, shortWindow);
        const longVol = buildRollingStdDev(returns, lookback);

        return createSignalLoop(cleanData, [shortVol, longVol], (i) => {
            const sv = shortVol[i];
            const lv = longVol[i];
            if (sv === null || lv === null || lv <= 0) return null;

            const ratio = sv / lv;
            if (!Number.isFinite(ratio) || ratio < EXPANSION_RATIO_GATE) return null;

            if (returns[i] > 0) {
                return createBuySignal(cleanData, i, `Vol expansion, up bar: ratio ${ratio.toFixed(2)}`);
            }
            if (returns[i] < 0) {
                return createSellSignal(cleanData, i, `Vol expansion, down bar: ratio ${ratio.toFixed(2)}`);
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
