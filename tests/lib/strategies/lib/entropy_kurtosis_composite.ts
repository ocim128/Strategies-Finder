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
    buildRollingEntropy,
    buildRollingKurtosis,
    buildRollingMedian,
} from "./price-action-statistics-core";

function normalizeEntropyKurtosisCompositeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 55))),
    };
}

export const entropy_kurtosis_composite: Strategy = {
    name: "Entropy Kurtosis Composite",
    description:
        "OR-combines falling return entropy and rising excess kurtosis when either distribution transition agrees with the rolling median.",
    defaultParams: {
        lookback: 55,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEntropyKurtosisCompositeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyKurtosisCompositeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, lookback);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const kurtosisRoc = buildRateOfChange(kurtosis.map((value) => value ?? 0), 1);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [entropy, kurtosis, kurtosisRoc, median], (i) => {
            const currentEntropy = entropy[i];
            const previousEntropy = entropy[i - 1];
            const kurtosisChange = kurtosisRoc[i];
            const med = median[i];
            if (currentEntropy === null || previousEntropy === null || kurtosisChange === null || med === null) return null;

            const entropyOrdering = currentEntropy < previousEntropy;
            const kurtosisResolving = kurtosisChange > 0;

            if ((entropyOrdering || kurtosisResolving) && closes[i] > med) {
                return createBuySignal(cleanData, i, "Entropy/kurtosis composite aligned above median");
            }
            if ((entropyOrdering || kurtosisResolving) && closes[i] < med) {
                return createSellSignal(cleanData, i, "Entropy/kurtosis composite aligned below median");
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
