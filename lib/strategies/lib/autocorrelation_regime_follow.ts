import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeAutocorrelationRegimeFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        autocorrMin: Math.max(-1, Math.min(1, Number(params.autocorrMin ?? 0.20))),
    };
}

export const autocorrelation_regime_follow: Strategy = {
    name: "Autocorrelation Regime Follow",
    description: "Autocorrelation regime with directional close acceptance.",
    defaultParams: {
        lookback: 25,
        autocorrMin: 0.20,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Autocorr Min",
    },
    normalizeParams: normalizeAutocorrelationRegimeFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationRegimeFollowParams(params);
        const lookback = p.lookback as number;
        const autocorrMin = p.autocorrMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;

            const acc = closeAcceptance[i];
            if (ac > autocorrMin) {
                if (acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Trending autocorrelation ${ac.toFixed(2)} with positive close acceptance ${acc.toFixed(2)}`
                    );
                }
                if (acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Trending autocorrelation ${ac.toFixed(2)} with negative close acceptance ${acc.toFixed(2)}`
                    );
                }
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
