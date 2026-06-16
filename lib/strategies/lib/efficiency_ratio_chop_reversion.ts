import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        erMax: Math.max(0, Math.min(1, Number(params.erMax ?? 0.3))),
    };
}

export const efficiency_ratio_chop_reversion: Strategy = {
    name: "Efficiency Ratio Chop Reversion",
    description: "Fades large cumulative moves that occurred with low efficiency, implying noise rather than repricing.",
    defaultParams: {
        lookback: 20,
        erMax: 0.3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        erMax: "Max Efficiency Ratio",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const roc = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, roc], (i) => {
            const er = efficiency[i];
            const change = roc[i];
            if (er === null || change === null) return null;

            if (er < p.erMax) {
                // Buy: inefficient downside move -> long reversion
                if (change < 0) {
                    return createBuySignal(cleanData, i, `Efficiency chop buy: ER ${er.toFixed(2)} with ROC ${change.toFixed(4)}`);
                }
                // Sell: inefficient upside move -> short reversion
                if (change > 0) {
                    return createSellSignal(cleanData, i, `Efficiency chop sell: ER ${er.toFixed(2)} with ROC ${change.toFixed(4)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "erMax"],
    },
};
