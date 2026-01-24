import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateEMA } from '../indicators';
import { COLORS } from '../constants';

/**
 * Trendline Breakout Strategy
 * 
 * Logic:
 * - Uses EMA for bias determination (bullish if close > EMA, bearish if close < EMA)
 * - Detects pivot highs/lows using left/right bar sensitivity
 * - Connects two most recent pivots within lookback to form trendline
 * - Bullish bias: Looks for descending trendline (older high > newer high)
 * - Bearish bias: Looks for ascending trendline (older low < newer low)
 * - Long entry: Breakout above descending trendline
 * - Short entry: Breakout below ascending trendline
 * 
 * No repainting: Uses confirmed pivots with right_bars offset
 */

interface Pivot {
    bar: number;
    value: number;
}

/**
 * Detects pivot highs using left/right bar sensitivity
 * Returns array of confirmed pivots (no repainting)
 */
function detectPivotHighs(highs: number[], leftBars: number, rightBars: number): Pivot[] {
    const pivots: Pivot[] = [];

    // Start from leftBars, end at length - rightBars to ensure full window
    for (let i = leftBars; i < highs.length - rightBars; i++) {
        let isPivot = true;

        // Check left side
        for (let j = 1; j <= leftBars; j++) {
            if (highs[i] <= highs[i - j]) {
                isPivot = false;
                break;
            }
        }

        if (!isPivot) continue;

        // Check right side
        for (let j = 1; j <= rightBars; j++) {
            if (highs[i] <= highs[i + j]) {
                isPivot = false;
                break;
            }
        }

        if (isPivot) {
            pivots.push({ bar: i, value: highs[i] });
        }
    }

    return pivots;
}

/**
 * Detects pivot lows using left/right bar sensitivity
 */
function detectPivotLows(lows: number[], leftBars: number, rightBars: number): Pivot[] {
    const pivots: Pivot[] = [];

    for (let i = leftBars; i < lows.length - rightBars; i++) {
        let isPivot = true;

        // Check left side
        for (let j = 1; j <= leftBars; j++) {
            if (lows[i] >= lows[i - j]) {
                isPivot = false;
                break;
            }
        }

        if (!isPivot) continue;

        // Check right side
        for (let j = 1; j <= rightBars; j++) {
            if (lows[i] >= lows[i + j]) {
                isPivot = false;
                break;
            }
        }

        if (isPivot) {
            pivots.push({ bar: i, value: lows[i] });
        }
    }

    return pivots;
}

/**
 * Gets the two most recent pivots within lookback window
 */
function getTwoRecentPivots(pivots: Pivot[], currentBar: number, lookback: number): [Pivot | null, Pivot | null] {
    let p1: Pivot | null = null;
    let p2: Pivot | null = null;

    // Scan from most recent to oldest
    for (let i = pivots.length - 1; i >= 0; i--) {
        const pivot = pivots[i];

        // Skip pivots outside lookback window
        if (pivot.bar < currentBar - lookback) {
            break;
        }

        // Skip future pivots (shouldn't happen but safety check)
        if (pivot.bar >= currentBar) {
            continue;
        }

        if (!p1) {
            p1 = pivot;
        } else if (!p2) {
            p2 = pivot;
            break; // Found both
        }
    }

    return [p1, p2];
}

/**
 * Calculates trendline Y value at given bar
 */
function calculateTrendlineY(p1: Pivot, p2: Pivot, bar: number): number | null {
    if (p1.bar === p2.bar) return null;

    const slope = (p1.value - p2.value) / (p1.bar - p2.bar);
    return p1.value + slope * (bar - p1.bar);
}

export const trendline_breakout: Strategy = {
    name: 'Trendline Breakout',
    description: 'Trades breakouts of dynamic trendlines formed by pivot points, filtered by EMA bias',
    defaultParams: {
        emaLength: 200,
        lookback: 20,
        leftBars: 5,
        rightBars: 5
    },
    paramLabels: {
        emaLength: 'EMA Length',
        lookback: 'Lookback Window (bars)',
        leftBars: 'Pivot Left Sensitivity',
        rightBars: 'Pivot Right Sensitivity'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < Math.max(params.emaLength, params.lookback + params.leftBars + params.rightBars)) {
            return [];
        }

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        // Calculate EMA for bias
        const ema = calculateEMA(closes, params.emaLength);

        // Detect all pivots (confirmed, no repainting)
        const pivotHighs = detectPivotHighs(highs, params.leftBars, params.rightBars);
        const pivotLows = detectPivotLows(lows, params.leftBars, params.rightBars);

        const signals: Signal[] = [];

        // Start checking from the point where we have enough data
        const startIdx = Math.max(params.emaLength, params.lookback + params.leftBars + params.rightBars);

        for (let i = startIdx; i < cleanData.length; i++) {
            if (ema[i] === null || ema[i - 1] === null) continue;

            const biasBull = closes[i] > ema[i]!;
            const biasBear = closes[i] < ema[i]!;

            // Bullish bias: Look for descending trendline breakout
            if (biasBull) {
                const [p1h, p2h] = getTwoRecentPivots(pivotHighs, i, params.lookback);

                // Validate: need two pivots, p2 is older than p1, and descending (p2.value > p1.value)
                if (p1h && p2h && p2h.bar < p1h.bar && p2h.value > p1h.value) {
                    const trendlineY = calculateTrendlineY(p1h, p2h, i);
                    const prevTrendlineY = calculateTrendlineY(p1h, p2h, i - 1);

                    if (trendlineY !== null && prevTrendlineY !== null) {
                        // Crossover: prev close below trendline, current close above
                        if (closes[i - 1] <= prevTrendlineY && closes[i] > trendlineY) {
                            signals.push(createBuySignal(
                                cleanData,
                                i,
                                `Bullish trendline breakout (EMA bias)`
                            ));
                        }
                    }
                }
            }

            // Bearish bias: Look for ascending trendline breakout
            if (biasBear) {
                const [p1l, p2l] = getTwoRecentPivots(pivotLows, i, params.lookback);

                // Validate: need two pivots, p2 is older than p1, and ascending (p2.value < p1.value)
                if (p1l && p2l && p2l.bar < p1l.bar && p2l.value < p1l.value) {
                    const trendlineY = calculateTrendlineY(p1l, p2l, i);
                    const prevTrendlineY = calculateTrendlineY(p1l, p2l, i - 1);

                    if (trendlineY !== null && prevTrendlineY !== null) {
                        // Crossunder: prev close above trendline, current close below
                        if (closes[i - 1] >= prevTrendlineY && closes[i] < trendlineY) {
                            signals.push(createSellSignal(
                                cleanData,
                                i,
                                `Bearish trendline breakout (EMA bias)`
                            ));
                        }
                    }
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const closes = getCloses(cleanData);
        const ema = calculateEMA(closes, params.emaLength);

        const indicators: StrategyIndicator[] = [
            { name: 'EMA', type: 'line', values: ema, color: COLORS.MA }
        ];

        // Optionally: Add trendline visualization
        // This would require extending the indicator type to support line segments
        // For now, just return the EMA

        return indicators;
    }
};
