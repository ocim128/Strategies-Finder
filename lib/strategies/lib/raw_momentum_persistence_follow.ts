import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeRawMomentumPersistenceFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        autocorrMin: Math.max(0, Math.min(1, Number(params.autocorrMin ?? 0.50))),
    };
}

export const raw_momentum_persistence_follow: Strategy = {
    name: "Raw Momentum Persistence Follow",
    description: "Return autocorrelation direction without quality gates.",
    defaultParams: {
        lookback: 20,
        autocorrMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Autocorr Min",
    },
    normalizeParams: normalizeRawMomentumPersistenceFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRawMomentumPersistenceFollowParams(params);
        const lookback = p.lookback as number;
        const autocorrMin = p.autocorrMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);

        return createSignalLoop(cleanData, [autocorr, returns], (i) => {
            const ac = autocorr[i];
            const ret = returns[i];
            if (ac === null || ret === null) return null;

            if (ac > autocorrMin && ret > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Positive autocorrelation ${ac.toFixed(2)} and positive return`
                );
            }
            if (ac > autocorrMin && ret < 0) {
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
        walkForwardParams: ["lookback", "autocorrMin"],
    },
};
