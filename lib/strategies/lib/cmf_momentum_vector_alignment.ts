import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

const CMF_MOMENTUM_VECTOR_MEDIAN_LOOKBACK = 55;

function normalizeCmfMomentumVectorAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmf_lookback: Math.max(2, Math.round(Number(params.cmf_lookback ?? 20))),
        vector_lookback: Math.max(1, Math.round(Number(params.vector_lookback ?? 10))),
    };
}

export const cmf_momentum_vector_alignment: Strategy = {
    name: "CMF Momentum Vector Alignment",
    description:
        "Requires Chaikin Money Flow to be directionally aligned and still accelerating before price is allowed to follow through relative to a longer median anchor.",
    defaultParams: {
        cmf_lookback: 20,
        vector_lookback: 10,
    },
    paramLabels: {
        cmf_lookback: "CMF Lookback",
        vector_lookback: "Vector Lookback",
    },
    normalizeParams: normalizeCmfMomentumVectorAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfMomentumVectorAlignmentParams(params);
        const cmfLookback = p.cmf_lookback as number;
        const vectorLookback = p.vector_lookback as number;
        const minBars = Math.max(CMF_MOMENTUM_VECTOR_MEDIAN_LOOKBACK, cmfLookback + vectorLookback);
        if (cleanData.length < minBars) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const cmf = calculateCMF(highs, lows, closes, volumes, cmfLookback);
        const cmfRoc = buildRateOfChange(cmf.map((value) => value ?? 0), vectorLookback);
        const median = buildRollingMedian(closes, CMF_MOMENTUM_VECTOR_MEDIAN_LOOKBACK);

        return createSignalLoop(cleanData, [cmf, cmfRoc, median], (i) => {
            const cmfValue = cmf[i];
            const rocValue = cmfRoc[i];
            const med = median[i];
            if (cmfValue === null || rocValue === null || med === null) return null;

            if (cmfValue > 0 && rocValue > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, "Positive CMF vector with close above 55-day median");
            }
            if (cmfValue < 0 && rocValue < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, "Negative CMF vector with close below 55-day median");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cmf_lookback", "vector_lookback"],
    },
};
