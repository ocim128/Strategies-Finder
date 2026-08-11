import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";

const ROTATION_LEVEL = 0.15;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const intrabar_rotation_persistence_follow: Strategy = {
    name: "Intrabar Rotation Persistence Follow",
    description: "Follows persistent same-bar open-to-close rotation: bars consistently opening low and closing high (or vice versa).",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Rotation Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const opens = getOpens(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        // Same-bar rotation: how far the close sits above the open within the bar's own range.
        const rotation: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            if (range <= 0) continue;
            const openLoc = (opens[i] - lows[i]) / range;
            const closeLoc = (closes[i] - lows[i]) / range;
            rotation[i] = closeLoc - openLoc;
        }
        const avgRotation = buildRollingAverage(rotation, lookback);

        return createSignalLoop(cleanData, [avgRotation], (i) => {
            const prev = avgRotation[i - 1];
            const curr = avgRotation[i];
            if (prev === null || curr === null) return null;

            if (prev <= ROTATION_LEVEL && curr > ROTATION_LEVEL) {
                return createBuySignal(cleanData, i, `Intrabar rotation buy: avg rotation ${curr.toFixed(3)} crossed above ${ROTATION_LEVEL}`);
            }
            if (prev >= -ROTATION_LEVEL && curr < -ROTATION_LEVEL) {
                return createSellSignal(cleanData, i, `Intrabar rotation sell: avg rotation ${curr.toFixed(3)} crossed below ${-ROTATION_LEVEL}`);
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
