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

const AC_LOOKBACK = 20;

function normalizeReturnAutocorrelationRegimeGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        acThreshold: Math.max(0.05, Math.min(0.9, Number(params.acThreshold ?? 0.3))),
    };
}

export const return_autocorrelation_regime_gate: Strategy = {
    name: "Return Autocorrelation Regime Gate",
    description: "Routes between continuation and reversion using a magic threshold on rolling return autocorrelation.",
    defaultParams: {
        acThreshold: 0.3,
    },
    paramLabels: {
        acThreshold: "Autocorrelation Threshold",
    },
    normalizeParams: normalizeReturnAutocorrelationRegimeGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnAutocorrelationRegimeGateParams(params);
        const acThreshold = p.acThreshold as number;
        if (cleanData.length < AC_LOOKBACK) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const returnsClean = closeReturn.map((v) => v ?? 0);
        const ac = buildRollingAutoCorrelation(returnsClean, AC_LOOKBACK, 1);

        return createSignalLoop(cleanData, [ac], (i) => {
            if (i < AC_LOOKBACK) return null;
            const acValue = ac[i];
            if (acValue === null) return null;

            if ((acValue > acThreshold && closeReturn[i] > 0) || (acValue < -acThreshold && closeReturn[i] < 0)) {
                return createBuySignal(cleanData, i, `Return autocorrelation ${acValue.toFixed(2)} routes ${acValue > 0 ? "trend" : "reversion"} buy`);
            }
            if ((acValue > acThreshold && closeReturn[i] < 0) || (acValue < -acThreshold && closeReturn[i] > 0)) {
                return createSellSignal(cleanData, i, `Return autocorrelation ${acValue.toFixed(2)} routes ${acValue > 0 ? "trend" : "reversion"} sell`);
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
