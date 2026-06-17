import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildThresholdCrossingCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        crossingMin: Math.max(1, Math.round(Number(params.crossingMin ?? 6))),
    };
}

export const return_reversal_count_reversion: Strategy = {
    name: "Return Reversal Count Reversion",
    description: "Mean-reversion using zero-crossing frequency of returns to detect oscillating regimes.",
    defaultParams: {
        lookback: 20,
        crossingMin: 6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        crossingMin: "Min Zero-Crossings",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const crossingCount = buildThresholdCrossingCount(returns, lookback, 0);

        return createSignalLoop(cleanData, [crossingCount], (i) => {
            const cc = crossingCount[i];
            if (cc === null) return null;

            const r = returns[i];

            // Buy: oscillatory environment with negative current return
            if (cc >= p.crossingMin && r < 0) {
                return createBuySignal(cleanData, i, `Return reversal count buy: crossings ${cc}`);
            }
            // Sell: oscillatory environment with positive current return
            if (cc >= p.crossingMin && r > 0) {
                return createSellSignal(cleanData, i, `Return reversal count sell: crossings ${cc}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "crossingMin"],
    },
};
