import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildAdjacentRangeOverlapSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_threshold: Math.max(0.01, Number(params.gap_threshold ?? 0.05)),
    };
}

export const adjacent_range_island_reversal_gap: Strategy = {
    name: "Adjacent Range Island Reversal Gap",
    description: "Enters island reversals when consecutive negative-overlap gaps isolate an opposing session bar.",
    defaultParams: {
        gap_threshold: 0.05,
    },
    paramLabels: {
        gap_threshold: "Gap Overlap Threshold",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const gapThreshold = Number(params.gap_threshold);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 2) return null;
            const oPrev = overlap[i - 1];
            const oCurr = overlap[i];
            if (oPrev === null || oCurr === null) return null;

            if (
                oPrev < -gapThreshold &&
                cleanData[i - 1].high < cleanData[i - 2].low &&
                oCurr < -gapThreshold &&
                cleanData[i].low > cleanData[i - 1].high
            ) {
                return createBuySignal(cleanData, i, `Bullish island reversal: gap down then gap up, overlap[i-1]=${oPrev.toFixed(3)}, overlap[i]=${oCurr.toFixed(3)}`);
            }

            if (
                oPrev < -gapThreshold &&
                cleanData[i - 1].low > cleanData[i - 2].high &&
                oCurr < -gapThreshold &&
                cleanData[i].high < cleanData[i - 1].low
            ) {
                return createSellSignal(cleanData, i, `Bearish island reversal: gap up then gap down, overlap[i-1]=${oPrev.toFixed(3)}, overlap[i]=${oCurr.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["gap_threshold"],
    },
};
