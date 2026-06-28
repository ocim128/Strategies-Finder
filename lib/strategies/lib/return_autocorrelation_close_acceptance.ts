import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        autocorrMin: Math.max(0.05, Math.min(0.95, Number(params.autocorrMin ?? 0.20))),
    };
}

export const return_autocorrelation_close_acceptance: Strategy = {
    name: "Return Autocorrelation Close Acceptance",
    description: "Follows close acceptance direction when autocorrelation confirms a trending regime.",
    defaultParams: {
        lookback: 25,
        autocorrMin: 0.20,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Min Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;
            if (ac < (p.autocorrMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `AC ${ac.toFixed(2)} trending acceptance bullish`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `AC ${ac.toFixed(2)} trending acceptance bearish`);
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
