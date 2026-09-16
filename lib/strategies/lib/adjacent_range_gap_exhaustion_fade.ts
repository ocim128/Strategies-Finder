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
        gap_threshold: Math.max(0, Number(params.gap_threshold ?? 0.1)),
    };
}

export const adjacent_range_gap_exhaustion_fade: Strategy = {
    name: "Adjacent Range Gap Exhaustion Fade",
    description: "Fades complete price gap separations (negative overlap) when the gap bar shows intra-bar exhaustion.",
    defaultParams: {
        gap_threshold: 0.1,
    },
    paramLabels: {
        gap_threshold: "Gap Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.gap_threshold as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [overlap, closeLocation], (i) => {
            if (i < 1) return null;
            const ov = overlap[i];
            const cl = closeLocation[i];
            if (ov === null || cl === null) return null;

            if (ov < -threshold) {
                // Gap down with exhaustion (closeLocation >= 0.40) -> buy fade
                if (cleanData[i].high < cleanData[i - 1].low && cl >= 0.40) {
                    return createBuySignal(cleanData, i, `Bullish gap exhaustion fade: overlap ${ov.toFixed(2)} < -${threshold}, gap down, closeLocation ${cl.toFixed(2)} >= 0.40`);
                }
                // Gap up with exhaustion (closeLocation <= 0.60) -> sell fade
                if (cleanData[i].low > cleanData[i - 1].high && cl <= 0.60) {
                    return createSellSignal(cleanData, i, `Bearish gap exhaustion fade: overlap ${ov.toFixed(2)} < -${threshold}, gap up, closeLocation ${cl.toFixed(2)} <= 0.60`);
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
