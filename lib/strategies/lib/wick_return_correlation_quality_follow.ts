import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

const ALIGNMENT_LEVEL = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const wick_return_correlation_quality_follow: Strategy = {
    name: "Wick-Return Correlation Quality Follow",
    description: "Follows moves aligned with functional wick absorption: bars where lower-wick dominance actually precedes advances (and the mirror).",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Alignment Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const corr = buildRollingCorrelation(wickImbalance, closeReturn, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null) return null;
            const ret = closeReturn[i];

            // Positive alignment: lower-wick bars are the ones that advance.
            if (c > ALIGNMENT_LEVEL && ret > 0) {
                return createBuySignal(cleanData, i, `Wick-return quality buy: corr ${c.toFixed(2)} with up return ${(ret * 100).toFixed(2)}%`);
            }
            if (c < -ALIGNMENT_LEVEL && ret < 0) {
                return createSellSignal(cleanData, i, `Wick-return quality sell: corr ${c.toFixed(2)} with down return ${(ret * 100).toFixed(2)}%`);
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
