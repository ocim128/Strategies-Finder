import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeCloseAcceptanceStateAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const close_acceptance_state_alignment: Strategy = {
    name: "Close Acceptance State Alignment",
    description:
        "Pairs the close-acceptance series with a trailing rolling median so entries reflect both bullish or bearish bar settlement quality and position versus a causal center.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCloseAcceptanceStateAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseAcceptanceStateAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            if (i < lookback - 1) return null;

            const med = median[i];
            if (med === null) return null;

            if (acceptance[i] > 0 && closes[i] > med) {
                return createBuySignal(cleanData, i, `Positive close acceptance ${acceptance[i].toFixed(3)} above median`);
            }
            if (acceptance[i] < 0 && closes[i] < med) {
                return createSellSignal(cleanData, i, `Negative close acceptance ${acceptance[i].toFixed(3)} below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
