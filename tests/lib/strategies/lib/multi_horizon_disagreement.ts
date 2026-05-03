import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    checkCrossover,
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeMultiHorizonDisagreementParams(params: StrategyParams): StrategyParams {
    const shortWindow = Math.max(2, Math.round(Number(params.short_window ?? 20)));
    const longWindow = Math.max(shortWindow + 1, Math.round(Number(params.long_window ?? 126)));
    return {
        ...params,
        short_window: shortWindow,
        long_window: longWindow,
    };
}

export const multi_horizon_disagreement: Strategy = {
    name: "Multi Horizon Disagreement Resolution",
    description:
        "Uses short-versus-long rolling-median disagreement and enters toward the longer-horizon bias when the close resolves across the short median.",
    defaultParams: {
        short_window: 20,
        long_window: 126,
    },
    paramLabels: {
        short_window: "Short Window",
        long_window: "Long Window",
    },
    normalizeParams: normalizeMultiHorizonDisagreementParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMultiHorizonDisagreementParams(params);
        const shortWindow = p.short_window as number;
        const longWindow = p.long_window as number;
        if (cleanData.length < longWindow + 1) return [];

        const closes = getCloses(cleanData);
        const shortMedian = buildRollingMedian(closes, shortWindow);
        const longMedian = buildRollingMedian(closes, longWindow);

        return createSignalLoop(cleanData, [shortMedian, longMedian], (i) => {
            if (i < longWindow) return null;

            const shortMed = shortMedian[i];
            const longMed = longMedian[i];
            if (shortMed === null || longMed === null) return null;

            const cross = checkCrossover(closes, shortMedian, i);
            if (shortMed < longMed && cross === "bullish") {
                return createBuySignal(cleanData, i, "Short median resolved upward toward long horizon");
            }
            if (shortMed > longMed && cross === "bearish") {
                return createSellSignal(cleanData, i, "Short median resolved downward toward long horizon");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["short_window", "long_window"],
    },
};
