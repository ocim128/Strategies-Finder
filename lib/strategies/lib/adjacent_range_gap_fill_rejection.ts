import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildAdjacentRangeOverlapSeries,
    buildCloseLocationSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        gap_threshold: Math.max(0, Number(params.gap_threshold ?? 0.08)),
    };
}

export const adjacent_range_gap_fill_rejection: Strategy = {
    name: "Adjacent Range Gap Fill Rejection",
    description: "Trades continuation when price probes into a negative-overlap gap void but strongly rejects at the boundary.",
    defaultParams: {
        gap_threshold: 0.08,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const gap_threshold = p.gap_threshold as number;
        if (cleanData.length < 3) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, clsLoc], (i) => {
            if (i < 2) return null;
            const prevOverlap = overlap[i - 1];
            const loc = clsLoc[i];
            if (prevOverlap === null || loc === null) return null;

            if (prevOverlap < -gap_threshold) {
                // Bullish: bar i-1 gapped up (low[i-1] > high[i-2]), bar i probes into gap (low[i] <= low[i-1]), rejects with high close location
                if (cleanData[i - 1].low > cleanData[i - 2].high && cleanData[i].low <= cleanData[i - 1].low && loc >= 0.70) {
                    return createBuySignal(cleanData, i, `Bullish gap fill rejection: prior gap up overlap ${prevOverlap.toFixed(3)} < -${gap_threshold}, probed low <= prior low, close location ${loc.toFixed(3)} >= 0.70`);
                }
                // Bearish: bar i-1 gapped down (high[i-1] < low[i-2]), bar i probes into gap (high[i] >= high[i-1]), rejects with low close location
                if (cleanData[i - 1].high < cleanData[i - 2].low && cleanData[i].high >= cleanData[i - 1].high && loc <= 0.30) {
                    return createSellSignal(cleanData, i, `Bearish gap fill rejection: prior gap down overlap ${prevOverlap.toFixed(3)} < -${gap_threshold}, probed high >= prior high, close location ${loc.toFixed(3)} <= 0.30`);
                }
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
