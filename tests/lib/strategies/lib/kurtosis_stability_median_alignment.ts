import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingMedian } from "./price-action-statistics-core";

function normalizeKurtosisStabilityMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 126))),
        kurtosis_max: Math.max(-3, Number(params.kurtosis_max ?? 3)),
    };
}

export const kurtosis_stability_median_alignment: Strategy = {
    name: "Kurtosis Stability Median Alignment",
    description:
        "Limits median-aligned trend entries to lower excess-kurtosis regimes where tail risk is not dominating the move.",
    defaultParams: {
        lookback: 126,
        kurtosis_max: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosis_max: "Kurtosis Max",
    },
    normalizeParams: normalizeKurtosisStabilityMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKurtosisStabilityMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        const kurtosisMax = p.kurtosis_max as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [kurtosis, median], (i) => {
            const kurt = kurtosis[i];
            const med = median[i];
            if (kurt === null || med === null || kurt >= kurtosisMax) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Stable kurtosis ${kurt.toFixed(2)} above median`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Stable kurtosis ${kurt.toFixed(2)} below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosis_max"],
    },
};
