import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from './lib/types/index';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateEMA } from '../indicators';
import { COLORS } from '../constants';

// ============================================================================
// Fibonacci Speed Fan (No Look-Ahead) v2
// ============================================================================
//
// PRINCIPLE: All signals are generated using ONLY data available at bar open.
// - Use: open[i], close[i-1], high[i-1], low[i-1], and all prior bars
// - Never use: close[i], high[i], low[i] (these are only known at bar close)
//
// CONCEPT: Trend-Following with Fibonacci Fan from Confirmed Swings
// 1. Detect swing highs/lows using COMPLETED bars only (up to i-1)
// 2. Draw Fib fan lines from the last two confirmed swings
// 3. Signal when OPEN of current bar crosses fan levels
//    (compared to close of previous bar)
//
// This ensures signals appear at bar open and never repaint.
//
// ============================================================================

// ============================================================================
// Types
// ============================================================================

interface Swing {
    index: number;
    price: number;
    isHigh: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detects swing highs and lows using ONLY completed bars.
 * At bar index `currentBar`, we can only confirm swings up to `currentBar - 1 - lookback`.
 * 
 * A swing high at index `i` requires:
 * - high[i] > high[i-1], high[i-2], ..., high[i-lookback]
 * - high[i] > high[i+1], high[i+2], ..., high[i+lookback]
 * 
 * This can only be confirmed when we have data up to i+lookback.
 * So at bar `currentBar`, the latest confirmable swing is at `currentBar - 1 - lookback`.
 */
function detectSwingsUpTo(
    high: number[],
    low: number[],
    lookback: number,
    upToIndex: number, // We have data up to and including this index
    minSwingPercent: number = 0.5 // Minimum swing size as % of price
): Swing[] {
    const swings: Swing[] = [];

    // The latest index we can check is upToIndex - lookback (need lookback bars after)
    const lastCheckable = upToIndex - lookback;

    if (lastCheckable < lookback) return swings;

    let lastSwing: Swing | null = null;

    for (let i = lookback; i <= lastCheckable; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;

        // Check both sides of the potential swing
        for (let j = 1; j <= lookback; j++) {
            if (high[i] <= high[i - j] || high[i] <= high[i + j]) {
                isSwingHigh = false;
            }
            if (low[i] >= low[i - j] || low[i] >= low[i + j]) {
                isSwingLow = false;
            }
        }

        // If both, prefer based on which is more extreme
        if (isSwingHigh && isSwingLow) {
            // Rare case - check which direction is more significant
            const highMove = high[i] - Math.min(high[i - lookback], high[i + lookback]);
            const lowMove = Math.max(low[i - lookback], low[i + lookback]) - low[i];
            isSwingLow = lowMove > highMove;
            isSwingHigh = !isSwingLow;
        }

        if (isSwingHigh || isSwingLow) {
            const price = isSwingHigh ? high[i] : low[i];

            // Minimum swing size filter
            if (lastSwing) {
                const swingSize = Math.abs(price - lastSwing.price) / lastSwing.price * 100;
                if (swingSize < minSwingPercent) continue;

                // If same direction, update to more extreme
                if (lastSwing.isHigh === isSwingHigh) {
                    if ((isSwingHigh && price > lastSwing.price) ||
                        (!isSwingHigh && price < lastSwing.price)) {
                        swings[swings.length - 1] = { index: i, price, isHigh: isSwingHigh };
                        lastSwing = swings[swings.length - 1];
                    }
                    continue;
                }
            }

            const swing: Swing = { index: i, price, isHigh: isSwingHigh };
            swings.push(swing);
            lastSwing = swing;
        }
    }

    return swings;
}

/**
 * Calculate Fib fan level price at a given bar index.
 * Returns null if no valid fan exists yet.
 */
function getFanLevelAt(
    swing1: Swing,
    swing2: Swing,
    barIndex: number,
    fibLevel: number
): number | null {
    if (barIndex < swing2.index) return null;

    const priceRange = swing2.price - swing1.price;
    const barRange = swing2.index - swing1.index;

    if (barRange <= 0) return null;

    // Slope from swing1 to swing2
    const slope = priceRange / barRange;

    // Fan line starts at fib level position on the swing
    const fibPrice = swing1.price + priceRange * fibLevel;

    // Adjusted slope for the fan line
    const adjustedSlope = slope * (1 - fibLevel);

    // Project forward from swing2
    const barsFromSwing2 = barIndex - swing2.index;

    return fibPrice + adjustedSlope * barsFromSwing2;
}

// ============================================================================
// Strategy
// ============================================================================

export const fib_speed_fan_corrected2: Strategy = {
    name: 'Fib Speed Fan (No Look-Ahead)',
    description: 'Trend-following strategy using Fibonacci Speed Fan. Signals generated at bar OPEN using only prior data. No repainting.',
    defaultParams: {
        lookback: 5,           // Bars to confirm swing
        atrPeriod: 14,         // For volatility filter
        entryFib: 0.618,       // Entry fan level
        trendEma: 50,          // Trend filter EMA
        minSwingPct: 0.05      // Minimum swing size % (Reduced)
    },
    paramLabels: {
        lookback: 'Swing Lookback',
        atrPeriod: 'ATR Period',
        entryFib: 'Entry Fib Level',
        trendEma: 'Trend EMA Period',
        minSwingPct: 'Min Swing %'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        const lookback = params.lookback || 5;
        // Need enough bars to calculate EMA(50) and have some history
        const minBars = Math.max(lookback * 4, params.trendEma + 10);

        if (cleanData.length < minBars) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        // Pre-calculate indicators using PRIOR bars only
        const ema = calculateEMA(close, params.trendEma);

        const signals: Signal[] = [];
        const swings: Swing[] = [];
        let lastSignalType: 'buy' | 'sell' | null = null;

        // Helper to check for pivot at a specific index
        // A pivot at 'p' is confirmed when we are at 'p + lookback'
        // This checks if high[p] is the highest in [p-lookback ... p+lookback]
        const isPivotHigh = (p: number): boolean => {
            if (p < lookback || p >= high.length - lookback) return false;
            const val = high[p];
            for (let k = 1; k <= lookback; k++) {
                if (high[p - k] >= val || high[p + k] > val) return false;
            }
            return true;
        };

        const isPivotLow = (p: number): boolean => {
            if (p < lookback || p >= low.length - lookback) return false;
            const val = low[p];
            for (let k = 1; k <= lookback; k++) {
                if (low[p - k] <= val || low[p + k] < val) return false;
            }
            return true;
        };

        // Process every bar to update swings ONLY when they are confirmed by past data
        for (let i = lookback * 2; i < cleanData.length; i++) {
            // At bar i, we can confirm a pivot happened at i - lookback.
            // Why? because we have [i-lookback ... i] (lookback bars after pivot)
            // AND [i-2*lookback ... i-lookback] (lookback bars before pivot).

            // To be strictly "No Future", at Open of bar i, we only know Closed i-1.
            // So we can only confirm up to (i-1) - lookback.
            const confirmationBar = i - 1;
            const p = confirmationBar - lookback;

            if (p >= lookback) {
                let isHigh = isPivotHigh(p);
                let isLow = isPivotLow(p);

                if (isHigh && isLow) {
                    isLow = false; // Prioritize high or handle conflict
                }

                if (isHigh || isLow) {
                    const price = isHigh ? high[p] : low[p];

                    // ZigZag Update Logic
                    if (swings.length === 0) {
                        swings.push({ index: p, price, isHigh });
                    } else {
                        const lastSwing = swings[swings.length - 1];
                        const swingSize = Math.abs(price - lastSwing.price) / lastSwing.price * 100;

                        if (lastSwing.isHigh === isHigh) {
                            // Same direction: Update if more extreme
                            if ((isHigh && price > lastSwing.price) || (!isHigh && price < lastSwing.price)) {
                                swings[swings.length - 1] = { index: p, price, isHigh };
                            }
                        } else {
                            // Opposite direction: Add if significant enough
                            if (swingSize >= params.minSwingPct) {
                                swings.push({ index: p, price, isHigh });
                            }
                        }
                    }
                }
            }

            // --- SIGNAL GENERATION (Only if i >= minBars) ---
            if (i < minBars) continue;

            if (swings.length < 2) continue;

            // Use last 2 swings to generate fan
            const swing2 = swings[swings.length - 1];
            const swing1 = swings[swings.length - 2];

            // 2. Calculate Fan Levels at i-1
            const prevFanLevel = getFanLevelAt(swing1, swing2, i - 1, params.entryFib);
            const prevPrevFanLevel = getFanLevelAt(swing1, swing2, i - 2, params.entryFib);
            const prevFanLevel0 = getFanLevelAt(swing1, swing2, i - 1, 0);
            const prevPrevFanLevel0 = getFanLevelAt(swing1, swing2, i - 2, 0);
            const prevFanLevel1 = getFanLevelAt(swing1, swing2, i - 1, 1);
            const prevPrevFanLevel1 = getFanLevelAt(swing1, swing2, i - 2, 1);

            if (prevFanLevel === null || prevPrevFanLevel === null) continue;

            // 3. Trend Context (EMA at i-1)
            const prevEma = ema[i - 1];
            if (prevEma === null) continue;

            const isBullishTrend = close[i - 1] > prevEma;
            const isBearishTrend = close[i - 1] < prevEma;

            // 4. Signal Detection
            const prevClose = close[i - 1];
            const prevPrevClose = close[i - 2];

            let isBuy = false;
            let isSell = false;
            let reason = '';

            const isAfterSwingHigh = swing2.isHigh;
            const isAfterSwingLow = !swing2.isHigh;

            // BUY
            if (isAfterSwingHigh && isBullishTrend) {
                if (prevPrevClose < prevPrevFanLevel && prevClose > prevFanLevel) {
                    isBuy = true;
                    reason = `Close crossed above ${params.entryFib} fan`;
                }
            }

            if (prevFanLevel1 !== null && prevPrevFanLevel1 !== null) {
                if (prevPrevClose < prevPrevFanLevel1 && prevClose > prevFanLevel1) {
                    isBuy = true;
                    reason = 'Close broke above 1.0 fan level';
                }
            }

            // SELL
            if (isAfterSwingLow && isBearishTrend) {
                if (prevPrevClose > prevPrevFanLevel && prevClose < prevFanLevel) {
                    isSell = true;
                    reason = `Close crossed below ${params.entryFib} fan`;
                }
            }

            if (prevFanLevel0 !== null && prevPrevFanLevel0 !== null) {
                if (prevPrevClose > prevPrevFanLevel0 && prevClose < prevFanLevel0) {
                    isSell = true;
                    reason = 'Close broke below 0 fan level';
                }
            }

            // Prevent rapid signal flipping
            if (isBuy && isSell) continue;
            if (isBuy && lastSignalType === 'buy') continue;
            if (isSell && lastSignalType === 'sell') continue;

            if (isBuy) {
                signals.push(createBuySignal(cleanData, i, reason));
                lastSignalType = 'buy';
            } else if (isSell) {
                signals.push(createSellSignal(cleanData, i, reason));
                lastSignalType = 'sell';
            }
        }

        return signals;
    },

    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        const lookback = params.lookback || 5;

        if (cleanData.length < lookback * 4) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        // Get all confirmed swings up to the last bar
        const swings = detectSwingsUpTo(high, low, lookback, cleanData.length - 1, params.minSwingPct);

        if (swings.length < 2) return [];

        // ZigZag line
        const zigzag: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let s = 0; s < swings.length - 1; s++) {
            const start = swings[s];
            const end = swings[s + 1];
            const steps = end.index - start.index;
            if (steps <= 0) continue;
            const priceStep = (end.price - start.price) / steps;
            for (let i = start.index; i <= end.index; i++) {
                zigzag[i] = start.price + priceStep * (i - start.index);
            }
        }

        // Extend last swing to current
        const lastSwing = swings[swings.length - 1];
        for (let i = lastSwing.index; i < cleanData.length; i++) {
            zigzag[i] = lastSwing.price;
        }

        // EMA line
        const ema = calculateEMA(close, params.trendEma);

        // Fan levels from last two swings
        const swing1 = swings[swings.length - 2];
        const swing2 = swings[swings.length - 1];

        const fanEntry: (number | null)[] = new Array(cleanData.length).fill(null);
        const fan0: (number | null)[] = new Array(cleanData.length).fill(null);
        const fan1: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = swing2.index; i < cleanData.length; i++) {
            fanEntry[i] = getFanLevelAt(swing1, swing2, i, params.entryFib);
            fan0[i] = getFanLevelAt(swing1, swing2, i, 0);
            fan1[i] = getFanLevelAt(swing1, swing2, i, 1);
        }

        return [
            { name: 'ZigZag', type: 'line', values: zigzag, color: COLORS.Trend },
            { name: `EMA ${params.trendEma}`, type: 'line', values: ema, color: '#888888' },
            { name: `Fan ${params.entryFib}`, type: 'line', values: fanEntry, color: '#FFA500' },
            { name: 'Fan 0', type: 'line', values: fan0, color: '#FF6B6B' },
            { name: 'Fan 1', type: 'line', values: fan1, color: '#4ECDC4' }
        ];
    }
};

