import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingKurtosis, extractBarMetricSeries } from "./price-action-statistics-core";

const THIN_TAIL_MAX = 1;
const FAT_TAIL_MIN = 4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 40))),
    };
}

export const return_kurtosis_regime_switch: Strategy = {
    name: "Return Kurtosis Regime Switch",
    description: "Follows moves in thin-tailed return regimes and fades them in fat-tailed regimes.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Kurtosis Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        // buildRollingKurtosis returns EXCESS kurtosis (m4/m2^2 - 3).
        const kurt = buildRollingKurtosis(returns, lookback);

        return createSignalLoop(cleanData, [kurt], (i) => {
            const k = kurt[i];
            if (k === null) return null;

            if (k <= THIN_TAIL_MAX) {
                // Representative moves: follow the bar's direction.
                if (returns[i] > 0) {
                    return createBuySignal(cleanData, i, `Thin-tailed regime, up bar: kurt ${k.toFixed(2)}`);
                }
                if (returns[i] < 0) {
                    return createSellSignal(cleanData, i, `Thin-tailed regime, down bar: kurt ${k.toFixed(2)}`);
                }
            } else if (k >= FAT_TAIL_MIN) {
                // Outlier-dominated regime: fade the bar's direction.
                if (returns[i] < 0) {
                    return createBuySignal(cleanData, i, `Fat-tailed regime, down bar fades up: kurt ${k.toFixed(2)}`);
                }
                if (returns[i] > 0) {
                    return createSellSignal(cleanData, i, `Fat-tailed regime, up bar fades down: kurt ${k.toFixed(2)}`);
                }
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
