import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeNegativeAutocorrelationReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        closeLocationMax: Math.max(0.5, Math.min(1, Number(params.closeLocationMax ?? 0.85))),
        autocorrMax: Math.max(-1, Math.min(1, Number(params.autocorrMax ?? 0.0))),
    };
}

export const negative_autocorrelation_reversion: Strategy = {
    name: "Negative Autocorrelation Reversion",
    description: "Mean-reversion regime detection via negative autocorrelation.",
    defaultParams: {
        lookback: 25,
        closeLocationMax: 0.85,
        autocorrMax: 0.0,
    },
    paramLabels: {
        lookback: "Lookback",
        closeLocationMax: "Close Location Max",
        autocorrMax: "Autocorr Max",
    },
    normalizeParams: normalizeNegativeAutocorrelationReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeNegativeAutocorrelationReversionParams(params);
        const lookback = p.lookback as number;
        const closeLocationMax = p.closeLocationMax as number;
        const autocorrMax = p.autocorrMax as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;

            const cl = closeLocation[i];
            if (ac < autocorrMax) {
                if (cl < (1 - closeLocationMax)) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish reversion: close location ${cl.toFixed(2)} with negative autocorrelation ${ac.toFixed(2)}`
                    );
                }
                if (cl > closeLocationMax) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish reversion: close location ${cl.toFixed(2)} with negative autocorrelation ${ac.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "closeLocationMax", "autocorrMax"],
    },
};
