import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingMedian } from "./price-action-statistics-core";

function normalizeKurtosisTailPersistenceAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        kurtosis_lookback: Math.max(4, Math.round(Number(params.kurtosis_lookback ?? 63))),
        kurtosis_threshold: Number(params.kurtosis_threshold ?? 3),
    };
}

export const kurtosis_tail_persistence_alignment: Strategy = {
    name: "Kurtosis Tail Persistence Alignment",
    description:
        "Uses elevated rolling kurtosis as a fat-tail regime filter and aligns entries with the side of a trailing median only when outlier persistence is already present.",
    defaultParams: {
        kurtosis_lookback: 63,
        kurtosis_threshold: 3,
    },
    paramLabels: {
        kurtosis_lookback: "Kurtosis Lookback",
        kurtosis_threshold: "Kurtosis Threshold",
    },
    normalizeParams: normalizeKurtosisTailPersistenceAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKurtosisTailPersistenceAlignmentParams(params);
        const lookback = p.kurtosis_lookback as number;
        const threshold = p.kurtosis_threshold as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [kurtosis, median], (i) => {
            const kurt = kurtosis[i];
            const med = median[i];
            if (kurt === null || med === null || kurt <= threshold) return null;

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Kurtosis ${kurt.toFixed(2)} above threshold with close above median`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Kurtosis ${kurt.toFixed(2)} above threshold with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["kurtosis_lookback", "kurtosis_threshold"],
    },
};
