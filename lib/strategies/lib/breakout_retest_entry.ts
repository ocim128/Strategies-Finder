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
import { buildTrailingHighLow } from "./price-action-frequency-core";

const RETEST_VALIDITY_BARS = 12;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 55))),
    };
}

export const breakout_retest_entry: Strategy = {
    name: "Breakout Retest Entry",
    description: "Enters the continuation thesis on the first retest of a broken prior-window channel extreme, trading location for fill rate.",
    defaultParams: {
        lookback: 55,
    },
    paramLabels: {
        lookback: "Channel Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        // Causal state machine: recorded broken level and bars since the break.
        let buyLevel: number | null = null;
        let buyBarsSinceBreak = Number.POSITIVE_INFINITY;
        let sellLevel: number | null = null;
        let sellBarsSinceBreak = Number.POSITIVE_INFINITY;

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const high = highest[i];
            const low = lowest[i];
            if (high === null || low === null) return null;

            // Retest checks run before the break state updates so a recorded
            // level gets its final chance on the bar a newer break prints.
            if (buyLevel !== null && buyBarsSinceBreak <= RETEST_VALIDITY_BARS && lows[i] <= buyLevel && closes[i] >= buyLevel) {
                const retestedLevel = buyLevel;
                buyLevel = null;
                return createBuySignal(cleanData, i, `Breakout retest buy: prior high ${retestedLevel.toFixed(4)} held on retest`);
            }
            if (sellLevel !== null && sellBarsSinceBreak <= RETEST_VALIDITY_BARS && highs[i] >= sellLevel && closes[i] <= sellLevel) {
                const retestedLevel = sellLevel;
                sellLevel = null;
                return createSellSignal(cleanData, i, `Breakout retest sell: prior low ${retestedLevel.toFixed(4)} held on retest`);
            }

            // A newer break replaces the recorded level and restarts the window.
            if (closes[i] > high) {
                buyLevel = high;
                buyBarsSinceBreak = 1;
            } else if (buyLevel !== null) {
                buyBarsSinceBreak += 1;
            }
            if (closes[i] < low) {
                sellLevel = low;
                sellBarsSinceBreak = 1;
            } else if (sellLevel !== null) {
                sellBarsSinceBreak += 1;
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
