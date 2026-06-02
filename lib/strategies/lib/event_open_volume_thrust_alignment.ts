import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming event opening anchor is data[0].open and is stable throughout the execution series.
// #SUGGEST_VERIFY: Check behavior at index 0 and ensure volume Z-score does not produce zero-division errors under compression.
function normalizeEventOpenVolumeThrustParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
        zScoreThreshold: Math.max(0.1, Number(params.zScoreThreshold ?? 2.0)),
    };
}

export const event_open_volume_thrust_alignment: Strategy = {
    name: "Event Open Volume Thrust Alignment",
    description: "Captures early session breakouts when price departs from the event open anchor on a high volume Z-score thrust.",
    defaultParams: {
        lookback: 50,
        zScoreThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Z-score Lookback",
        zScoreThreshold: "Z-score Threshold",
    },
    normalizeParams: normalizeEventOpenVolumeThrustParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenVolumeThrustParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const eventOpen = cleanData[0].open;
        const volumes = getVolumes(cleanData);
        const volZ = buildRollingZScore(volumes, lookback);

        return createSignalLoop(cleanData, [volZ], (i) => {
            if (i < lookback) return null;
            const currentClose = cleanData[i].close;
            const currentVolZ = volZ[i];

            if (currentVolZ === null) return null;

            // Trigger when the volume Z-score is greater than zScoreThreshold
            if (currentVolZ > p.zScoreThreshold) {
                // Bullish: Close is above the event open price
                if (currentClose > eventOpen) {
                    return createBuySignal(cleanData, i, `Event Open Volume Thrust Bullish (volZ=${currentVolZ.toFixed(2)}, close=${currentClose.toFixed(2)})`);
                }
                // Bearish: Close is below the event open price
                if (currentClose < eventOpen) {
                    return createSellSignal(cleanData, i, `Event Open Volume Thrust Bearish (volZ=${currentVolZ.toFixed(2)}, close=${currentClose.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zScoreThreshold"],
    },
};
