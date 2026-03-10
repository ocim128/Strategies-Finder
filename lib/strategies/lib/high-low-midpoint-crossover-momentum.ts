import { Strategy, OHLCVData, StrategyParams, Signal } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";

/**
 * High-Low Midpoint Crossover Momentum
 *
 * Uses the midpoint of each bar's high-low range as a structural trend filter,
 * then trades when price crosses multiple consecutive midpoints in one direction.
 * This is different from moving averages because it uses bar structure, not time-based averaging.
 *
 * Why Rare: Most traders use moving averages, pivot points, or price action patterns
 * for trend filtering. Using bar midpoints as structural filters is rare because midpoints
 * are not commonly used as technical indicators.
 */
export const high_low_midpoint_crossover_momentum: Strategy = {
    name: "High-Low Midpoint Crossover Momentum",
    description: "Uses bar midpoints as structural trend filters, trading consecutive midpoint crosses.",
    defaultParams: {
        midpointBars: 3,
        crossThreshold: 0.001,
        minRangePct: 0.003,
    },
    paramLabels: {
        midpointBars: "Midpoint Bars",
        crossThreshold: "Cross Threshold (%)",
        minRangePct: "Min Range (%)",
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 6) return [];

        const midpointBars = Math.max(2, Math.min(6, Math.round(params.midpointBars ?? 3)));
        const crossThreshold = Math.max(0, params.crossThreshold ?? 0.001);
        const minRangePct = Math.max(0.001, params.minRangePct ?? 0.003);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        // Calculate midpoints for each bar
        const midpoints: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < cleanData.length; i++) {
            const range = highs[i] - lows[i];
            if (range > 0) {
                midpoints[i] = (highs[i] + lows[i]) / 2;
            }
        }

        const signals: Signal[] = [];

        for (let i = midpointBars + 1; i < cleanData.length; i++) {
            let allAboveMidpoint = true;
            let allBelowMidpoint = true;
            let validBars = 0;

            // Check if previous N bars close above/below their respective midpoints
            for (let j = i - midpointBars; j <= i - 1; j++) {
                const midpoint = midpoints[j];
                if (midpoint === null) {
                    allAboveMidpoint = false;
                    allBelowMidpoint = false;
                    break;
                }

                const bar = cleanData[j];
                const range = bar.high - bar.low;
                const rangePct = range / Math.max(Math.abs(bar.close), 1e-9);

                if (rangePct < minRangePct) {
                    allAboveMidpoint = false;
                    allBelowMidpoint = false;
                    break;
                }

                validBars++;

                if (closes[j] <= midpoint) {
                    allAboveMidpoint = false;
                }
                if (closes[j] >= midpoint) {
                    allBelowMidpoint = false;
                }
            }

            if (validBars < midpointBars) continue;

            const prevClose = closes[i - 1];
            const currClose = closes[i];
            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];
            const priceRef = Math.max(Math.abs(prevClose), 1e-9);

            // Check for bullish continuation
            if (allAboveMidpoint) {
                const bullishBreak = (currClose - prevHigh) / priceRef > crossThreshold;
                if (bullishBreak) {
                    signals.push(createBuySignal(cleanData, i, "Midpoint crossover momentum bullish"));
                }
            }

            // Check for bearish continuation
            if (allBelowMidpoint) {
                const bearishBreak = (prevLow - currClose) / priceRef > crossThreshold;
                if (bearishBreak) {
                    signals.push(createSellSignal(cleanData, i, "Midpoint crossover momentum bearish"));
                }
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["midpointBars", "crossThreshold", "minRangePct"],
    },
};
