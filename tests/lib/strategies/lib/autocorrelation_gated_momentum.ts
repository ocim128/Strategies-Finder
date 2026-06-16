import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    buildRateOfChange,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        acThreshold: Math.max(-1, Math.min(1, Number(params.acThreshold ?? 0.20))),
    };
}

export const autocorrelation_gated_momentum: Strategy = {
    name: "Autocorrelation Gated Momentum",
    description: "Follows close return momentum when returns autocorrelation confirms a trending regime.",
    defaultParams: {
        lookback: 30,
        acThreshold: 0.20,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acThreshold: "Min Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const roc = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [autoCorr, roc], (i) => {
            const ac = autoCorr[i];
            const change = roc[i];
            if (ac === null || change === null) return null;

            if (ac > p.acThreshold) {
                // Buy: positive autocorrelation and positive rate of change -> follow momentum
                if (change > 0) {
                    return createBuySignal(cleanData, i, `Autocorrelation momentum buy: AC ${ac.toFixed(2)} with ROC ${change.toFixed(4)}`);
                }
                // Sell: positive autocorrelation and negative rate of change -> follow momentum
                if (change < 0) {
                    return createSellSignal(cleanData, i, `Autocorrelation momentum sell: AC ${ac.toFixed(2)} with ROC ${change.toFixed(4)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acThreshold"],
    },
};
