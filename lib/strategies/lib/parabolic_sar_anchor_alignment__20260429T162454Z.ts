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
import { calculateParabolicSAR } from "../indicators";

function normalizeParabolicSarAnchorAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 63))),
    };
}

export const parabolic_sar_anchor_alignment: Strategy = {
    name: "Parabolic SAR Anchor Alignment",
    description:
        "Uses Parabolic SAR as a dynamic acceleration-based anchor and aligns entries by whether the daily close is holding above or below the current SAR value.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeParabolicSarAnchorAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParabolicSarAnchorAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const sar = calculateParabolicSAR(highs, lows, 0.02, 0.02, 0.2);

        return createSignalLoop(cleanData, [sar], (i) => {
            const sarValue = sar[i];
            if (sarValue === null) return null;

            if (closes[i] > sarValue) {
                return createBuySignal(cleanData, i, `Close above Parabolic SAR ${sarValue.toFixed(2)}`);
            }
            if (closes[i] < sarValue) {
                return createSellSignal(cleanData, i, `Close below Parabolic SAR ${sarValue.toFixed(2)}`);
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
