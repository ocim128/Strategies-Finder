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
        max_overlap: Math.max(0, Math.min(1, Number(params.max_overlap ?? 0.05))),
    };
}

export const adjacent_range_zero_overlap_breakout: Strategy = {
    name: "Adjacent Range Zero Overlap Breakout",
    description: "Enters directional expansion when consecutive range overlap is near zero without a full gap (0 <= overlap <= max_overlap).",
    defaultParams: {
        max_overlap: 0.05,
    },
    paramLabels: {
        max_overlap: "Max Overlap",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const maxOverlap = p.max_overlap as number;
        if (cleanData.length < 2) return [];

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;
            const ov = overlap[i];
            if (ov === null) return null;

            if (ov >= 0 && ov <= maxOverlap) {
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createBuySignal(cleanData, i, `Bullish zero-overlap breakout: overlap ${ov.toFixed(3)} in [0, ${maxOverlap}], close > prior high`);
                }
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createSellSignal(cleanData, i, `Bearish zero-overlap breakout: overlap ${ov.toFixed(3)} in [0, ${maxOverlap}], close < prior low`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_overlap"],
    },
};
