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
import { calculateKeltnerChannels } from "../indicators";

const FIXED_KELTNER_MULTIPLIER = 1.5;

function normalizeKeltnerMidpointAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const keltner_midpoint_alignment: Strategy = {
    name: "Keltner Midpoint Alignment",
    description:
        "Uses the Keltner midpoint as a volatility-adjusted daily value anchor and enters whenever the completed close accepts above or below that centerline.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeKeltnerMidpointAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKeltnerMidpointAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const channels = calculateKeltnerChannels(
            highs,
            lows,
            closes,
            lookback,
            lookback,
            FIXED_KELTNER_MULTIPLIER
        );

        return createSignalLoop(cleanData, [channels.middle], (i) => {
            if (i < lookback - 1) return null;

            const midpoint = channels.middle[i];
            if (midpoint === null) return null;

            if (closes[i] > midpoint) {
                return createBuySignal(cleanData, i, `Close above Keltner midpoint ${midpoint.toFixed(2)}`);
            }
            if (closes[i] < midpoint) {
                return createSellSignal(cleanData, i, `Close below Keltner midpoint ${midpoint.toFixed(2)}`);
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
