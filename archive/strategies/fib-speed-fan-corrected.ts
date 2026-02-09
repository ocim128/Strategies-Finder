import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateATR } from '../indicators';
import { COLORS } from '../constants';

// ============================================================================
// Helper Functions
// ============================================================================

interface Pivot {
    index: number;
    price: number;
    isHigh: boolean;
    confirmationIndex: number;
}

/**
 * Calculates the deviation threshold based on ATR.
 * Higher values require more significant price moves to create new pivots.
 */
function calculateDeviationThreshold(atr: (number | null)[], close: number[], multiplier: number): number[] {
    const threshold: number[] = [];
    for (let i = 0; i < close.length; i++) {
        const atrValue = atr[i];
        if (atrValue === null || close[i] === 0) {
            threshold.push(0);
        } else {
            threshold.push((atrValue / close[i]) * 100 * multiplier);
        }
    }
    return threshold;
}

/**
 * Detects pivot highs and lows using a confirmation-based window to avoid look-ahead.
 * A pivot at `index` is confirmed only when `currentBar >= index + halfDepth`.
 */
function detectPivots(
    high: number[],
    low: number[],
    depth: number,
    devThreshold: number[]
): Pivot[] {
    const pivots: Pivot[] = [];
    const halfDepth = Math.floor(depth / 2);

    if (high.length < depth + 1) return pivots;

    let lastPivot: Pivot | null = null;

    for (let currentBar = 2 * halfDepth; currentBar < high.length; currentBar++) {
        const index = currentBar - halfDepth;
        let isHigh = true;
        let isLow = true;

        // Check if index is a pivot high or low using the confirmation window
        for (let j = index - halfDepth; j <= index + halfDepth; j++) {
            if (j === index) continue;
            if (high[j] >= high[index]) isHigh = false;
            if (low[j] <= low[index]) isLow = false;
            if (!isHigh && !isLow) break;
        }

        if (isHigh || isLow) {
            const price = isHigh ? high[index] : low[index];
            const currentThreshold = devThreshold[index] || 0;
            const newPivot: Pivot = { index, price, isHigh, confirmationIndex: currentBar };

            // Check deviation from last pivot
            if (lastPivot) {
                const deviation = Math.abs((price - lastPivot.price) / lastPivot.price) * 100;

                // Same direction pivot - update if more extreme
                if (isHigh === lastPivot.isHigh) {
                    if ((isHigh && price > lastPivot.price) || (!isHigh && price < lastPivot.price)) {
                        // Update the last pivot instead of adding new
                        pivots[pivots.length - 1] = newPivot;
                        lastPivot = newPivot;
                    }
                } else if (deviation > currentThreshold) {
                    // Opposite direction with significant deviation - new pivot
                    pivots.push(newPivot);
                    lastPivot = newPivot;
                }
            } else {
                pivots.push(newPivot);
                lastPivot = newPivot;
            }
        }
    }

    return pivots;
}

/**
 * Fibonacci levels used for the speed fan.
 */

/**
 * Calculates Fib fan price levels at each bar index based on the last two pivots.
 * Returns an object with levels for each Fib ratio.
 */
/**
 * Calculates price levels for a single Fib fan level at each bar index based on pivots.
 */
function calculateArbitraryFanLevel(
    data: OHLCVData[],
    pivots: Pivot[],
    level: number
): (number | null)[] {
    const levels: (number | null)[] = new Array(data.length).fill(null);
    if (pivots.length < 2) return levels;

    // For each pair of consecutive pivots, calculate fan levels extending forward
    for (let p = 0; p < pivots.length - 1; p++) {
        const startPivot = pivots[p];
        const endPivot = pivots[p + 1];

        const priceRange = endPivot.price - startPivot.price;
        const barRange = endPivot.index - startPivot.index;

        if (barRange <= 0) continue;

        // Calculate the slope (price change per bar)
        const slope = priceRange / barRange;
        const fibPrice = startPivot.price + priceRange * level;
        const adjustedSlope = slope * (1 - level);

        // Fan levels are only valid from the end pivot's confirmation index
        const startIndex = endPivot.confirmationIndex;
        const extensionEnd = p + 2 < pivots.length
            ? Math.min(data.length - 1, pivots[p + 2].confirmationIndex - 1)
            : data.length - 1;

        if (startIndex > extensionEnd) continue;

        // For each bar from the confirmation index to the extension end
        for (let i = startIndex; i <= extensionEnd; i++) {
            const barsFromEnd = i - endPivot.index;

            // Fan line: starts at fiblLevel point on the price range, extends with adjusted slope
            const fanPrice = fibPrice + adjustedSlope * barsFromEnd;

            levels[i] = fanPrice;
        }
    }

    return levels;
}

// ============================================================================
// Fib Speed Fan Strategy
// ============================================================================

export const fib_speed_fan_corrected: Strategy = {
    name: 'Fibonacci Speed Fan (Corrected)',
    description: 'Generates signals based on price interaction with confirmed Fibonacci Speed Fan levels to avoid look-ahead bias',
    defaultParams: {
        depth: 10,
        atrPeriod: 10,
        entryLevel: 0.618,
        exitLevel: 0.382
    },
    paramLabels: {
        depth: 'Pivot Depth',
        atrPeriod: 'ATR Period',
        entryLevel: 'Entry Fib Level',
        exitLevel: 'Exit Fib Level'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < params.depth * 2) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        const atr = calculateATR(high, low, close, params.atrPeriod);
        // Deviation multiplier is fixed at 0 (not configurable)
        const devThreshold = calculateDeviationThreshold(atr, close, 0);
        const pivots = detectPivots(high, low, params.depth, devThreshold);

        if (pivots.length < 2) return [];

        const entryLevels = calculateArbitraryFanLevel(cleanData, pivots, params.entryLevel);
        const exitLevels = calculateArbitraryFanLevel(cleanData, pivots, params.exitLevel);
        const levels0 = calculateArbitraryFanLevel(cleanData, pivots, 0);
        const levels1 = calculateArbitraryFanLevel(cleanData, pivots, 1);

        if (entryLevels.length === 0 || exitLevels.length === 0) return [];

        const signals: Signal[] = [];

        let lastPivotWasHigh = false;

        // Track the last confirmed pivot for signal context
        let currentPivotIndex = -1;

        for (let i = 1; i < cleanData.length; i++) {
            // Update current pivot context
            while (currentPivotIndex < pivots.length - 1 && pivots[currentPivotIndex + 1].confirmationIndex <= i) {
                currentPivotIndex++;
                lastPivotWasHigh = pivots[currentPivotIndex].isHigh;
            }

            const entryLevel = entryLevels[i];
            const exitLevel = exitLevels[i];
            const prevEntry = entryLevels[i - 1];
            const prevExit = exitLevels[i - 1];

            if (entryLevel === null || exitLevel === null || prevEntry === null || prevExit === null) continue;

            let isBuy = false;
            let isSell = false;
            let signalReason = '';

            // After a swing high (bearish context), look for bullish reversal signals
            // Price crossing above entry level after being below
            if (lastPivotWasHigh) {
                // Bearish fan context - look for support/buy signals
                if (close[i - 1] <= prevEntry && close[i] > entryLevel) {
                    isBuy = true;
                    signalReason = `Price crossed above ${params.entryLevel} fan level (support bounce)`;
                }
            } else {
                // Bullish fan context (after swing low) - look for resistance/sell signals  
                if (close[i - 1] >= prevEntry && close[i] < entryLevel) {
                    isSell = true;
                    signalReason = `Price crossed below ${params.entryLevel} fan level (resistance rejection)`;
                }
            }

            // Alternative: Fib level breakout signals
            const level0 = levels0[i];
            const level1 = levels1[i];
            const prevLevel0 = levels0[i - 1];
            const prevLevel1 = levels1[i - 1];

            if (level0 !== null && level1 !== null && prevLevel0 !== null && prevLevel1 !== null) {
                // Breakout above 1.0 level (uptrend continuation)
                if (close[i - 1] <= prevLevel1 && close[i] > level1) {
                    isBuy = true;
                    signalReason = 'Breakout above 1.0 Fib fan level';
                }
                // Breakdown below 0 level (downtrend continuation)
                if (close[i - 1] >= prevLevel0 && close[i] < level0) {
                    isSell = true;
                    signalReason = 'Breakdown below 0 Fib fan level';
                }
            }

            // Prevent simultaneous buy and sell signals
            if (isBuy && isSell) {
                continue;
            }

            if (isBuy) {
                signals.push(createBuySignal(cleanData, i, signalReason));
            } else if (isSell) {
                signals.push(createSellSignal(cleanData, i, signalReason));
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < params.depth * 2) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        const atr = calculateATR(high, low, close, params.atrPeriod);
        // Deviation multiplier is fixed at 0 (not configurable)
        const devThreshold = calculateDeviationThreshold(atr, close, 0);
        const pivots = detectPivots(high, low, params.depth, devThreshold);

        if (pivots.length < 2) return [];



        // Create ZigZag line connecting pivots
        const zigzag: (number | null)[] = new Array(cleanData.length).fill(null);
        for (const pivot of pivots) {
            zigzag[pivot.index] = pivot.price;
        }
        // Linear interpolation between pivots
        for (let p = 0; p < pivots.length - 1; p++) {
            const start = pivots[p];
            const end = pivots[p + 1];
            const priceStep = (end.price - start.price) / (end.index - start.index);
            for (let i = start.index; i <= end.index; i++) {
                zigzag[i] = start.price + priceStep * (i - start.index);
            }
        }

        const indicators: StrategyIndicator[] = [
            { name: 'ZigZag', type: 'line', values: zigzag, color: COLORS.Trend }
        ];

        // Note: UI fans (rainbow) were removed as requested to declutter the chart.
        // The strategy continues to use these levels for signal generation internally.


        return indicators;
    }
};
