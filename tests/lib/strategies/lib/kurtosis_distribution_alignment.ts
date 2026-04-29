import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingMedian } from "./price-action-statistics-core";

function normalizeKurtosisDistributionAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 63))),
    };
}

export const kurtosis_distribution_alignment: Strategy = {
    name: "Kurtosis Distribution Alignment",
    description:
        "Uses excess kurtosis of daily closes as a higher-moment regime filter and aligns entries with the side of a trailing rolling median only when tails are elevated.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeKurtosisDistributionAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKurtosisDistributionAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [kurtosis, median], (i) => {
            if (i < lookback - 1) return null;

            const kurt = kurtosis[i];
            const med = median[i];
            if (kurt === null || med === null || kurt <= 0) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Elevated excess kurtosis ${kurt.toFixed(3)} with close above median`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Elevated excess kurtosis ${kurt.toFixed(3)} with close below median`);
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
