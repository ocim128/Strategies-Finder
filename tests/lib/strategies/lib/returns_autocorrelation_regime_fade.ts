import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
        acMax: Math.max(-1, Math.min(1, Number(params.acMax ?? -0.1))),
    };
}

export const returns_autocorrelation_regime_fade: Strategy = {
    name: "Returns Autocorrelation Regime Fade",
    description: "Fades the direction of the current bar's return when returns autocorrelation indicates a mean-reverting regime.",
    defaultParams: {
        lookback: 20,
        acMax: -0.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acMax: "Max Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const autoCorr = buildRollingAutoCorrelation(returns, lookback, 1);

        return createSignalLoop(cleanData, [autoCorr], (i) => {
            const ac = autoCorr[i];
            if (ac === null) return null;

            const ret = returns[i];

            if (ac < p.acMax) {
                // Buy: oscillation regime and current return is negative -> long the reversion
                if (ret < 0) {
                    return createBuySignal(cleanData, i, `Autocorrelation fade buy: AC ${ac.toFixed(2)} with return ${ret.toFixed(4)}`);
                }
                // Sell: oscillation regime and current return is positive -> short the reversion
                if (ret > 0) {
                    return createSellSignal(cleanData, i, `Autocorrelation fade sell: AC ${ac.toFixed(2)} with return ${ret.toFixed(4)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acMax"],
    },
};
