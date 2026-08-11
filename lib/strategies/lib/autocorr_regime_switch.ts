import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingAutoCorrelation,
} from "./price-action-statistics-core";

const REGIME_THRESHOLD = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const autocorr_regime_switch: Strategy = {
    name: "Autocorrelation Regime Switch",
    description: "Trades with the last return when lag-1 autocorrelation certifies trending, and against it when it certifies reversion.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Autocorrelation Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // One-bar returns; the leading null is coerced so the autocorrelation
        // window and the current-bar sign both stay dense.
        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const autocorr = buildRollingAutoCorrelation(returns, lookback, 1);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;
            const ret = returns[i];

            // Positive autocorrelation: the last return persists. Negative: it reverses.
            const buyMomentum = ac >= REGIME_THRESHOLD && ret > 0;
            const buyFade = ac <= -REGIME_THRESHOLD && ret < 0;
            const sellMomentum = ac >= REGIME_THRESHOLD && ret < 0;
            const sellFade = ac <= -REGIME_THRESHOLD && ret > 0;

            if (buyMomentum || buyFade) {
                return createBuySignal(cleanData, i, `Autocorr regime buy: ac ${ac.toFixed(2)} ${ac >= REGIME_THRESHOLD ? "trending" : "reverting"} with return ${(ret * 100).toFixed(2)}%`);
            }
            if (sellMomentum || sellFade) {
                return createSellSignal(cleanData, i, `Autocorr regime sell: ac ${ac.toFixed(2)} ${ac >= REGIME_THRESHOLD ? "trending" : "reverting"} with return ${(ret * 100).toFixed(2)}%`);
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
