import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minStreak: Math.max(3, Math.min(10, Math.round(params.minStreak ?? 4))) };
}

type PreparedData = {
    cleanData: OHLCVData[];
    upStreak: number[];
    downStreak: number[];
};

function prepareData(data: OHLCVData[]): PreparedData {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        upStreak: [],
        downStreak: [] };
}

function getPreparedData(preparedData: unknown, data: OHLCVData[]): PreparedData {
    if (preparedData && typeof preparedData === "object" && "cleanData" in preparedData) {
        return preparedData as PreparedData;
    }
    return prepareData(data);
}

export const consecutive_direction_fade: Strategy = {
    name: "Consecutive Direction Fade",
    description: "After N consecutive bars closing in the same direction, the market has been moving monotonically. In mean-reverting markets, such streaks exhaust themselves. Enter opposite to the streak direction.",
    defaultParams: {
        minStreak: 4 },
    paramLabels: {
        minStreak: "Min Streak" },
    normalizeParams,
    prepareFinderData: (data) => prepareData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
        const prepared = getPreparedData(preparedData, data);
        const { cleanData } = prepared;

        const minStreak = Math.max(3, Math.min(10, Math.round(params.minStreak ?? 4)));

        if (cleanData.length < minStreak + 2) return [];

        // Calculate direction flags
        let upStreak = prepared.upStreak;
        let downStreak = prepared.downStreak;
        if (upStreak.length === 0) {
            const closes = getCloses(cleanData);
            // Up streak: close[i] >= close[i-1] ? 1 : 0
            const upFlags = new Array(closes.length).fill(0);
            const downFlags = new Array(closes.length).fill(0);
            for (let i = 1; i < closes.length; i++) {
                if (closes[i] >= closes[i - 1]) {
                    upFlags[i] = 1;
                } else {
                    downFlags[i] = 1;
                }
            }
            upStreak = buildStreakCount(upFlags);
            downStreak = buildStreakCount(downFlags);
            prepared.upStreak = upStreak;
            prepared.downStreak = downStreak;
        }

        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;

            
            const prevUpStreak = upStreak[i - 1];
            
            const prevDownStreak = downStreak[i - 1];
            const currentClose = closes[i];
            const prevClose = closes[i - 1];

            if (currentClose === null || prevClose === null) return null;

            // Buy: Down streak of at least minStreak AND first upward bar breaks the streak
            if (prevDownStreak >= minStreak && currentClose > prevClose) {
                return createBuySignal(cleanData, i, "Consecutive Direction Fade Long");
            }

            // Sell: Up streak of at least minStreak AND first downward bar breaks the streak
            if (prevUpStreak >= minStreak && currentClose < prevClose) {
                return createSellSignal(cleanData, i, "Consecutive Direction Fade Short");
            }

            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams) =>
        consecutive_direction_fade.executePrepared?.(prepareData(data), params, data) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minStreak"] } };
