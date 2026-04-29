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
import { calculateATR, calculateKeltnerChannels } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

const KELTNER_MIDPOINT_VOLATILITY_Z_LOOKBACK = 60;

function normalizeKeltnerMidpointVolatilityGatedAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        vol_z_threshold: Number(params.vol_z_threshold ?? 0),
    };
}

export const keltner_midpoint_volatility_gated_alignment: Strategy = {
    name: "Keltner Midpoint Volatility Gated Alignment",
    description:
        "Uses ATR compression as a volatility gate and only triggers when the close crosses the Keltner midpoint during that subdued regime.",
    defaultParams: {
        lookback: 20,
        vol_z_threshold: 0,
    },
    paramLabels: {
        lookback: "Lookback",
        vol_z_threshold: "Vol Z Threshold",
    },
    normalizeParams: normalizeKeltnerMidpointVolatilityGatedAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKeltnerMidpointVolatilityGatedAlignmentParams(params);
        const lookback = p.lookback as number;
        const volThreshold = p.vol_z_threshold as number;
        if (cleanData.length < Math.max(lookback, KELTNER_MIDPOINT_VOLATILITY_Z_LOOKBACK) + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrZScore = buildRollingZScore(atr.map((value) => value ?? 0), KELTNER_MIDPOINT_VOLATILITY_Z_LOOKBACK);
        const channels = calculateKeltnerChannels(highs, lows, closes, lookback, lookback, 1.5);

        return createSignalLoop(cleanData, [channels.middle, atrZScore], (i) => {
            const currentMid = channels.middle[i];
            const previousMid = channels.middle[i - 1];
            const currentZ = atrZScore[i];
            if (currentMid === null || previousMid === null || currentZ === null || currentZ >= volThreshold) return null;

            if (closes[i] > currentMid && closes[i - 1] <= previousMid) {
                return createBuySignal(cleanData, i, `Compressed ATR z-score ${currentZ.toFixed(2)} with Keltner midpoint cross up`);
            }
            if (closes[i] < currentMid && closes[i - 1] >= previousMid) {
                return createSellSignal(cleanData, i, `Compressed ATR z-score ${currentZ.toFixed(2)} with Keltner midpoint cross down`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "vol_z_threshold"],
    },
};
