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
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
        acThreshold: Math.max(-1, Math.min(1, Number(params.acThreshold ?? 0.3))),
    };
}

export const autocorrelation_regime_continuation: Strategy = {
    name: "Autocorrelation Regime Continuation",
    description: "Follows return momentum in trending regimes characterized by highly positive returns autocorrelation.",
    defaultParams: {
        lookback: 20,
        acThreshold: 0.3,
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
        const returns = buildRateOfChange(closes, 1);
        const retNumbers = returns.map((v) => (v !== null ? v : 0));

        const autoCorr = buildRollingAutoCorrelation(retNumbers, lookback, 1);

        return createSignalLoop(cleanData, [autoCorr], (i) => {
            const ac = autoCorr[i];
            if (ac === null) return null;

            const ret = retNumbers[i];

            if (ac > p.acThreshold) {
                // Buy: positive autocorrelation and current return is positive -> trend continuation
                if (ret > 0) {
                    return createBuySignal(cleanData, i, `Autocorrelation continuation buy: AC ${ac.toFixed(2)} with return ${ret.toFixed(4)}`);
                }
                // Sell: positive autocorrelation and current return is negative -> trend continuation
                if (ret < 0) {
                    return createSellSignal(cleanData, i, `Autocorrelation continuation sell: AC ${ac.toFixed(2)} with return ${ret.toFixed(4)}`);
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
