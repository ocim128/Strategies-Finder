import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeRawAutocorrelationDirectionFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
    };
}

export const raw_autocorrelation_direction_follow: Strategy = {
    name: "Raw Autocorrelation Direction Follow",
    description: "Autocorrelation as standalone direction signal.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRawAutocorrelationDirectionFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRawAutocorrelationDirectionFollowParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);

        return createSignalLoop(cleanData, [autocorr, returns], (i) => {
            const ac = autocorr[i];
            const ret = returns[i];
            if (ac === null || ret === null) return null;

            if (ac > 0 && ret > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive autocorrelation ${ac.toFixed(2)} and positive return`
                );
            }
            if (ac > 0 && ret < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Positive autocorrelation ${ac.toFixed(2)} and negative return`
                );
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
