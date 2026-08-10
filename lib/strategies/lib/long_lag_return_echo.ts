import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    extractBarMetricSeries,
    buildRollingAutoCorrelation,
} from "./price-action-statistics-core";

const AC_LOOKBACK = 40;
const AC_LAG = 12;

function normalizeLongLagReturnEchoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        acThreshold: Math.max(0.05, Math.min(0.9, Number(params.acThreshold ?? 0.25))),
    };
}

export const long_lag_return_echo: Strategy = {
    name: "Long Lag Return Echo",
    description: "Follows returns that repeat their own sign at a long fixed lag, treating the echo as periodic structure.",
    defaultParams: {
        acThreshold: 0.25,
    },
    paramLabels: {
        acThreshold: "Echo Autocorrelation Threshold",
    },
    normalizeParams: normalizeLongLagReturnEchoParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLongLagReturnEchoParams(params);
        const acThreshold = p.acThreshold as number;
        if (cleanData.length < AC_LOOKBACK + AC_LAG) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(closeReturn, AC_LOOKBACK, AC_LAG);

        return createSignalLoop(cleanData, [ac], (i) => {
            if (i < AC_LOOKBACK + AC_LAG - 1) return null;
            const acValue = ac[i];
            if (acValue === null) return null;

            if (acValue > acThreshold && closeReturn[i] > 0) {
                return createBuySignal(cleanData, i, `Long-lag return echo: autocorrelation ${acValue.toFixed(2)} at lag ${AC_LAG} with positive return`);
            }
            if (acValue > acThreshold && closeReturn[i] < 0) {
                return createSellSignal(cleanData, i, `Long-lag return echo: autocorrelation ${acValue.toFixed(2)} at lag ${AC_LAG} with negative return`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["acThreshold"],
    },
};
