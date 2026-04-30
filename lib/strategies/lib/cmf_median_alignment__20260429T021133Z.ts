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
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeCmfMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmf_period: Math.max(2, Math.round(Number(params.cmf_period ?? 21))),
        median_lookback: Math.max(2, Math.round(Number(params.median_lookback ?? 55))),
    };
}

export const cmf_median_alignment: Strategy = {
    name: "CMF Median Alignment",
    description:
        "Uses Chaikin Money Flow only as a zero-line participation gate, while keeping the primary entry anchor a simple trailing rolling median of daily closes.",
    defaultParams: {
        cmf_period: 21,
        median_lookback: 55,
    },
    paramLabels: {
        cmf_period: "CMF Period",
        median_lookback: "Median Lookback",
    },
    normalizeParams: normalizeCmfMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfMedianAlignmentParams(params);
        const cmfPeriod = p.cmf_period as number;
        const medianLookback = p.median_lookback as number;
        const minLookback = Math.max(cmfPeriod, medianLookback);
        if (cleanData.length < minLookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const cmf = calculateCMF(highs, lows, closes, volumes, cmfPeriod);
        const median = buildRollingMedian(closes, medianLookback);

        return createSignalLoop(cleanData, [cmf, median], (i) => {
            if (i < minLookback - 1) return null;

            const cmfValue = cmf[i];
            const med = median[i];
            if (cmfValue === null || med === null) return null;

            if (cmfValue > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive CMF ${cmfValue.toFixed(3)} with close above median`);
            }
            if (cmfValue < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative CMF ${cmfValue.toFixed(3)} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cmf_period", "median_lookback"],
    },
};
