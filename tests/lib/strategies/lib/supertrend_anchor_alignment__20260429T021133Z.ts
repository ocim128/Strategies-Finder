import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";

const FIXED_SUPERTREND_FACTOR = 3;

function normalizeSupertrendAnchorAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const supertrend_anchor_alignment: Strategy = {
    name: "Supertrend Anchor Alignment",
    description:
        "Uses the Supertrend line as a dynamic trailing value anchor and trades based on whether the completed daily close is accepted above or below that level.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSupertrendAnchorAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSupertrendAnchorAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const supertrend = calculateSupertrend(highs, lows, closes, lookback, FIXED_SUPERTREND_FACTOR);

        return createSignalLoop(cleanData, [supertrend.supertrend], (i) => {
            if (i < lookback - 1) return null;

            const anchor = supertrend.supertrend[i];
            if (anchor === null) return null;

            if (closes[i] > anchor) {
                return createBuySignal(cleanData, i, `Close above Supertrend anchor ${anchor.toFixed(2)}`);
            }
            if (closes[i] < anchor) {
                return createSellSignal(cleanData, i, `Close below Supertrend anchor ${anchor.toFixed(2)}`);
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
