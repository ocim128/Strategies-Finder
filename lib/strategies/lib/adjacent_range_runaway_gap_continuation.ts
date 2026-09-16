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
        gap_threshold: Math.max(0, Number(params.gap_threshold ?? 0.12)),
    };
}

export const adjacent_range_runaway_gap_continuation: Strategy = {
    name: "Adjacent Range Runaway Gap Continuation",
    description: "Trades momentum breakouts on synthetic pairs when disjoint bar ranges create negative adjacent overlap.",
    defaultParams: {
        gap_threshold: 0.12,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const gap_threshold = p.gap_threshold as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const clsLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, clsLoc], (i) => {
            if (i < 1) return null;
            const o = overlap[i];
            const loc = clsLoc[i];
            if (o === null || loc === null) return null;

            if (o < -gap_threshold) {
                if (cleanData[i].low > cleanData[i - 1].high && loc >= 0.80) {
                    return createBuySignal(cleanData, i, `Bullish runaway gap: overlap ${o.toFixed(3)} < -${gap_threshold}, low > prior high, close location ${loc.toFixed(3)} >= 0.80`);
                }
                if (cleanData[i].high < cleanData[i - 1].low && loc <= 0.20) {
                    return createSellSignal(cleanData, i, `Bearish runaway gap: overlap ${o.toFixed(3)} < -${gap_threshold}, high < prior low, close location ${loc.toFixed(3)} <= 0.20`);
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
