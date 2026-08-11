import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const OPEN_EXTREME_Z = 2.0;
const CONFIRMING_CLOSE = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const open_location_continuation_follow: Strategy = {
    name: "Open Location Continuation Follow",
    description: "Follows extreme opens within the prior bar's range when the current bar's close confirms rather than rejects them.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Open Location Window",
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

        // Open's position inside the PRIOR bar's range: 0 = at prior low, 1 = at prior high.
        const openLocation: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const priorRange = highs[i - 1] - lows[i - 1];
            if (priorRange <= 0) continue;
            openLocation[i] = (opens[i] - lows[i - 1]) / priorRange;
        }
        const openZ = buildRollingZScore(openLocation, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [openZ, closeLocation], (i) => {
            const z = openZ[i];
            const loc = closeLocation[i];
            if (z === null || loc === null || i < 1) return null;

            // Open near the prior low, close confirms upward: imbalance accepted.
            if (z <= -OPEN_EXTREME_Z && loc > CONFIRMING_CLOSE) {
                return createBuySignal(cleanData, i, `Open-location continuation buy: open z ${z.toFixed(2)} confirmed by close loc ${loc.toFixed(2)}`);
            }
            if (z >= OPEN_EXTREME_Z && loc < 1 - CONFIRMING_CLOSE) {
                return createSellSignal(cleanData, i, `Open-location continuation sell: open z ${z.toFixed(2)} confirmed by close loc ${loc.toFixed(2)}`);
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
