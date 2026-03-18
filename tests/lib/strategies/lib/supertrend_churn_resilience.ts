import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

export const supertrend_churn_resilience: Strategy = {
    name: "Supertrend Churn Resilience",
    description: "Validates trend persistence by tracking the crossing frequency of midpoints against the Supertrend line. A low crossing count verifies a highly resilient regime.",
    defaultParams: {
        stPeriod: 10,
        stMultiplier: 3,
        maxCrossings: 1,
    },
    paramLabels: {
        stPeriod: "Supertrend Period",
        stMultiplier: "Supertrend Multiplier",
        maxCrossings: "Max Allowed Crossings (20b)",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < (params.stPeriod as number)) return [];

        const st = calculateSupertrend(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            params.stPeriod as number,
            params.stMultiplier as number
        );

        const midpointDistance = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            if (st.supertrend[i] === null) continue;
            const mid = getPriceActionBarMetrics(cleanData[i]).midpoint;
            midpointDistance[i] = mid - st.supertrend[i]!;
        }

        const crossings = buildThresholdCrossingCount(midpointDistance, 20, 0); // 20-bar crossing of distance 0

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 20 || st.direction[i] === null || crossings[i] === null) return null;

            const isBullishSupertrend = st.direction[i] === 1;
            const isBearishSupertrend = st.direction[i] === -1;
            const isLowChurn = crossings[i]! <= (params.maxCrossings as number);
            
            const isUpCandle = cleanData[i].close > cleanData[i].open;
            const isDownCandle = cleanData[i].close < cleanData[i].open;

            if (isBullishSupertrend && isLowChurn && isUpCandle) {
                return createBuySignal(cleanData, i, "Resilient bullish supertrend low-churn continuation");
            }
            if (isBearishSupertrend && isLowChurn && isDownCandle) {
                return createSellSignal(cleanData, i, "Resilient bearish supertrend low-churn continuation");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["stPeriod", "stMultiplier", "maxCrossings"],
    },
};
