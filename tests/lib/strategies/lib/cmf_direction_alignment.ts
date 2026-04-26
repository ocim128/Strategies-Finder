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

function normalizeCmfDirectionAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        cmf_lookback: Math.max(1, Math.round(params.cmf_lookback ?? 20)),
        median_lookback: Math.max(2, Math.round(params.median_lookback ?? 20)),
    };
}

export const cmf_direction_alignment: Strategy = {
    name: "CMF Direction Alignment",
    description: "Chaikin Money Flow captures the direction of volume-weighted accumulation or distribution. When CMF sign agrees with price relative to a rolling median, both flow and price point the same way.",
    defaultParams: {
        cmf_lookback: 20,
        median_lookback: 20,
    },
    paramLabels: {
        cmf_lookback: "CMF Lookback",
        median_lookback: "Median Lookback",
    },
    normalizeParams: normalizeCmfDirectionAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCmfDirectionAlignmentParams(params);
        const cmfLookback = p.cmf_lookback as number;
        const medianLookback = p.median_lookback as number;
        if (cleanData.length < Math.max(cmfLookback, medianLookback) + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, medianLookback);
        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), closes, getVolumes(cleanData), cmfLookback);

        return createSignalLoop(cleanData, [median, cmf], (i) => {
            const center = median[i];
            const flow = cmf[i];
            if (center === null || flow === null) return null;

            if (flow > 0 && closes[i] > center) {
                return createBuySignal(cleanData, i, `CMF ${flow.toFixed(3)} positive and close above median ${center.toFixed(2)}`);
            }
            if (flow < 0 && closes[i] < center) {
                return createSellSignal(cleanData, i, `CMF ${flow.toFixed(3)} negative and close below median ${center.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["cmf_lookback", "median_lookback"],
    },
};
