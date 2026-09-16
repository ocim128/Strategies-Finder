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
        max_overlap: Math.max(0.05, Math.min(0.5, Number(params.max_overlap ?? 0.25))),
    };
}

export const adjacent_overlap_containment_detonation: Strategy = {
    name: "Adjacent Overlap Containment Detonation",
    description: "Enters breakout impulse when near-complete containment (overlap >= 0.90) abruptly collapses to low overlap.",
    defaultParams: {
        max_overlap: 0.25,
    },
    paramLabels: {
        max_overlap: "Maximum Detonation Overlap",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const maxOverlap = Number(params.max_overlap);

        const overlap = buildAdjacentRangeOverlapSeries(cleanData);

        return createSignalLoop(cleanData, [overlap], (i) => {
            if (i < 1) return null;
            const oPrev = overlap[i - 1];
            const oCurr = overlap[i];
            if (oPrev === null || oCurr === null) return null;

            if (oPrev >= 0.90 && oCurr <= maxOverlap) {
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createBuySignal(cleanData, i, `Bullish containment detonation: overlap ${oPrev.toFixed(2)} -> ${oCurr.toFixed(2)} <= ${maxOverlap}, close > prior high`);
                }
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createSellSignal(cleanData, i, `Bearish containment detonation: overlap ${oPrev.toFixed(2)} -> ${oCurr.toFixed(2)} <= ${maxOverlap}, close < prior low`);
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
