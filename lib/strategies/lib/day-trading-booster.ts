import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import {
    calculateEMA,
    calculateATR,
    calculateRSI,
    calculateADX
} from '../indicators';

// ============================================================================
// Day Trading Booster Strategy - Simplified Version
// ============================================================================
// A modular day trading strategy with toggleable components:
// - Opening Range Breakout (ORB)
// - VWAP with Standard Deviation Bands
// - EMA Crossover with trend filtering
// - Pivot Point Support/Resistance
// 
// DESIGN: Fewer parameters for easier walk-forward testing & optimization.
// Toggle params (useORB, useVWAP, etc.) can be randomly enabled/disabled.
// ============================================================================

// ============================================================================
// Constants
// ============================================================================

const COLORS = {
    vwap: '#2196f3',
    vwapUpper: '#4caf50',
    vwapLower: '#f44336',
    orbHigh: '#00bcd4',
    orbLow: '#ff9800',
    pivotHigh: '#e91e63',
    pivotLow: '#9c27b0',
    fastEma: '#26a69a',
    slowEma: '#ef5350'
};

// ============================================================================
// Types
// ============================================================================

interface PivotPoint {
    index: number;
    price: number;
    type: 'high' | 'low';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate VWAP with Standard Deviation Bands
 */
function calculateVWAPBands(data: OHLCVData[], multiplier: number = 2): {
    vwap: (number | null)[];
    upper: (number | null)[];
    lower: (number | null)[];
} {
    const len = data.length;
    const vwap: (number | null)[] = new Array(len).fill(null);
    const upper: (number | null)[] = new Array(len).fill(null);
    const lower: (number | null)[] = new Array(len).fill(null);

    let cumVolume = 0;
    let cumVolumePrice = 0;
    let cumVolumePrice2 = 0;

    for (let i = 0; i < len; i++) {
        const bar = data[i];
        const typicalPrice = (bar.high + bar.low + bar.close) / 3;
        const vol = bar.volume || 1;

        cumVolume += vol;
        cumVolumePrice += typicalPrice * vol;
        cumVolumePrice2 += typicalPrice * typicalPrice * vol;

        if (cumVolume > 0) {
            const avgPrice = cumVolumePrice / cumVolume;
            const variance = (cumVolumePrice2 / cumVolume) - (avgPrice * avgPrice);
            const stdDev = Math.sqrt(Math.max(0, variance));

            vwap[i] = avgPrice;
            upper[i] = avgPrice + (stdDev * multiplier);
            lower[i] = avgPrice - (stdDev * multiplier);
        }
    }

    return { vwap, upper, lower };
}

/**
 * Detect Opening Range (first N bars)
 */
function calculateOpeningRange(data: OHLCVData[], orbPeriod: number): {
    high: number;
    low: number;
    endIndex: number;
} {
    if (data.length < orbPeriod) {
        return { high: -Infinity, low: Infinity, endIndex: 0 };
    }

    let orbHigh = -Infinity;
    let orbLow = Infinity;

    for (let i = 0; i < orbPeriod; i++) {
        orbHigh = Math.max(orbHigh, data[i].high);
        orbLow = Math.min(orbLow, data[i].low);
    }

    return { high: orbHigh, low: orbLow, endIndex: orbPeriod - 1 };
}

/**
 * Simple Pivot Detection
 */
function detectPivots(
    high: number[],
    low: number[],
    lookback: number
): PivotPoint[] {
    const pivots: PivotPoint[] = [];
    const len = high.length;

    for (let i = lookback; i < len - lookback; i++) {
        let isHigh = true;
        let isLow = true;

        for (let k = 1; k <= lookback; k++) {
            if (high[i] <= high[i - k] || high[i] <= high[i + k]) isHigh = false;
            if (low[i] >= low[i - k] || low[i] >= low[i + k]) isLow = false;
        }

        if (isHigh) {
            pivots.push({ index: i, price: high[i], type: 'high' });
        }
        if (isLow) {
            pivots.push({ index: i, price: low[i], type: 'low' });
        }
    }

    return pivots;
}

/**
 * Trend Direction (simple EMA-based)
 */
function getTrend(
    close: number[],
    fastEma: (number | null)[],
    slowEma: (number | null)[],
    index: number
): 'bullish' | 'bearish' | 'neutral' {
    const fast = fastEma[index];
    const slow = slowEma[index];
    if (fast === null || slow === null) return 'neutral';
    if (fast > slow && close[index] > fast) return 'bullish';
    if (fast < slow && close[index] < fast) return 'bearish';
    return 'neutral';
}

// ============================================================================
// Signal Generation
// ============================================================================

function generateSignals(
    data: OHLCVData[],
    params: StrategyParams
): Signal[] {
    const signals: Signal[] = [];
    const len = data.length;

    const high = data.map(d => d.high);
    const low = data.map(d => d.low);
    const close = data.map(d => d.close);

    // Calculate indicators
    const fastEma = calculateEMA(close, params.fastPeriod);
    const slowEma = calculateEMA(close, params.slowPeriod);
    const atr = calculateATR(high, low, close, 14);
    const rsi = calculateRSI(close, 14);
    const adx = calculateADX(high, low, close, 14);

    // ORB
    const orb = calculateOpeningRange(data, params.orbPeriod);

    // VWAP
    const vwapBands = calculateVWAPBands(data, 2);

    // Pivots
    const pivots = detectPivots(high, low, params.pivotLookback);

    // State tracking
    let lastSignalType: 'buy' | 'sell' | null = null;
    let lastSignalIndex = -1;
    const minBars = 3;

    // Start after ORB period
    const startIndex = Math.max(orb.endIndex + 1, params.slowPeriod);

    for (let i = startIndex; i < len; i++) {
        if (lastSignalIndex >= 0 && i - lastSignalIndex < minBars) continue;

        const currClose = close[i];
        const prevClose = close[i - 1];
        const currHigh = high[i];
        const currLow = low[i];
        const vwap = vwapBands.vwap[i];
        const fast = fastEma[i];
        const slow = slowEma[i];
        const atrVal = atr[i];
        const rsiVal = rsi[i];
        const adxVal = adx[i];

        if (vwap === null || fast === null || slow === null || atrVal === null) continue;

        const trend = getTrend(close, fastEma, slowEma, i);

        // ADX filter - skip weak trends if enabled
        if (params.useADXFilter && adxVal !== null && adxVal < 20) continue;

        let buyScore = 0;
        let sellScore = 0;
        let reason = '';

        // ====================================================================
        // 1. ORB Signals (toggle: useORB)
        // ====================================================================
        if (params.useORB) {
            if (prevClose <= orb.high && currClose > orb.high && trend !== 'bearish') {
                buyScore += 2;
                reason = 'ORB Breakout';
            }
            if (prevClose >= orb.low && currClose < orb.low && trend !== 'bullish') {
                sellScore += 2;
                reason = 'ORB Breakdown';
            }
        }

        // ====================================================================
        // 2. VWAP Signals (toggle: useVWAP)
        // ====================================================================
        if (params.useVWAP) {
            // VWAP bounce
            if (currLow <= vwap && currClose > vwap && trend === 'bullish') {
                buyScore += 1;
                reason = reason || 'VWAP Bounce';
            }
            if (currHigh >= vwap && currClose < vwap && trend === 'bearish') {
                sellScore += 1;
                reason = reason || 'VWAP Rejection';
            }

            // Oversold at VWAP lower band
            if (currClose < (vwapBands.lower[i] ?? 0) && rsiVal !== null && rsiVal < 30) {
                buyScore += 1;
                reason = reason || 'VWAP Oversold';
            }
            if (currClose > (vwapBands.upper[i] ?? Infinity) && rsiVal !== null && rsiVal > 70) {
                sellScore += 1;
                reason = reason || 'VWAP Overbought';
            }
        }

        // ====================================================================
        // 3. EMA Crossover (toggle: useEMA)
        // ====================================================================
        if (params.useEMA) {
            const prevFast = fastEma[i - 1];
            const prevSlow = slowEma[i - 1];
            if (prevFast !== null && prevSlow !== null) {
                if (prevFast <= prevSlow && fast > slow) {
                    buyScore += 2;
                    reason = reason || 'EMA Cross Up';
                }
                if (prevFast >= prevSlow && fast < slow) {
                    sellScore += 2;
                    reason = reason || 'EMA Cross Down';
                }
            }
        }

        // ====================================================================
        // 4. Pivot Support/Resistance (toggle: usePivots)
        // ====================================================================
        if (params.usePivots && atrVal > 0) {
            const threshold = atrVal * 0.5;
            for (const pivot of pivots) {
                if (pivot.index < i - 10 || pivot.index >= i) continue;
                const distance = Math.abs(currClose - pivot.price);
                if (distance < threshold) {
                    if (pivot.type === 'low' && currClose > pivot.price && trend === 'bullish') {
                        buyScore += 1;
                        reason = reason || 'Pivot Support';
                    }
                    if (pivot.type === 'high' && currClose < pivot.price && trend === 'bearish') {
                        sellScore += 1;
                        reason = reason || 'Pivot Resistance';
                    }
                }
            }
        }

        // ====================================================================
        // Generate Signal (threshold = 2)
        // ====================================================================
        const threshold = 2;

        if (buyScore >= threshold && lastSignalType !== 'buy') {
            signals.push(createBuySignal(data, i, reason));
            lastSignalType = 'buy';
            lastSignalIndex = i;
        } else if (sellScore >= threshold && lastSignalType !== 'sell') {
            signals.push(createSellSignal(data, i, reason));
            lastSignalType = 'sell';
            lastSignalIndex = i;
        }
    }

    return signals;
}

// ============================================================================
// Strategy Export
// ============================================================================

export const day_trading_booster: Strategy = {
    name: 'Day Trading Booster',
    description:
        'Modular day trading strategy with toggleable components: ORB, VWAP, EMA crossover, and Pivot points. ' +
        'Simplified for robust walk-forward testing. Toggle params (use*) are randomly enabled/disabled during optimization.',

    // ========================================================================
    // SIMPLIFIED PARAMETERS
    // 4 toggle params (on/off) + 4 numeric params = 8 total
    // Much easier to optimize than 20+ params
    // ========================================================================
    defaultParams: {
        // === TOGGLE PARAMS (0 or 1) - randomly toggled in finder ===
        useORB: 1,           // Opening Range Breakout
        useVWAP: 1,          // VWAP signals
        useEMA: 1,           // EMA crossover
        usePivots: 1,        // Pivot support/resistance
        useADXFilter: 0,     // ADX trend strength filter

        // === NUMERIC PARAMS - optimizable ===
        orbPeriod: 6,        // Bars for opening range (e.g., first 30 min on 5m)
        fastPeriod: 9,       // Fast EMA period
        slowPeriod: 21,      // Slow EMA period
        pivotLookback: 5     // Bars left/right for pivot detection
    },

    paramLabels: {
        useORB: 'Use ORB (0/1)',
        useVWAP: 'Use VWAP (0/1)',
        useEMA: 'Use EMA Cross (0/1)',
        usePivots: 'Use Pivots (0/1)',
        useADXFilter: 'Use ADX Filter (0/1)',
        orbPeriod: 'ORB Period',
        fastPeriod: 'Fast EMA',
        slowPeriod: 'Slow EMA',
        pivotLookback: 'Pivot Lookback'
    },

    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 50) return [];
        return generateSignals(cleanData, params);
    },

    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < params.slowPeriod) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        const indicators: StrategyIndicator[] = [];

        // VWAP with Bands
        if (params.useVWAP) {
            const vwapBands = calculateVWAPBands(cleanData, 2);
            indicators.push({ name: 'VWAP', type: 'line', values: vwapBands.vwap, color: COLORS.vwap });
            indicators.push({ name: 'VWAP Upper', type: 'line', values: vwapBands.upper, color: COLORS.vwapUpper });
            indicators.push({ name: 'VWAP Lower', type: 'line', values: vwapBands.lower, color: COLORS.vwapLower });
        }

        // Opening Range
        if (params.useORB) {
            const orb = calculateOpeningRange(cleanData, params.orbPeriod);
            const orbHighLine: (number | null)[] = new Array(cleanData.length).fill(null);
            const orbLowLine: (number | null)[] = new Array(cleanData.length).fill(null);
            for (let i = 0; i < cleanData.length; i++) {
                orbHighLine[i] = orb.high;
                orbLowLine[i] = orb.low;
            }
            indicators.push({ name: 'ORB High', type: 'line', values: orbHighLine, color: COLORS.orbHigh });
            indicators.push({ name: 'ORB Low', type: 'line', values: orbLowLine, color: COLORS.orbLow });
        }

        // EMAs
        if (params.useEMA) {
            const fastEma = calculateEMA(close, params.fastPeriod);
            const slowEma = calculateEMA(close, params.slowPeriod);
            indicators.push({ name: 'Fast EMA', type: 'line', values: fastEma, color: COLORS.fastEma });
            indicators.push({ name: 'Slow EMA', type: 'line', values: slowEma, color: COLORS.slowEma });
        }

        // Pivot Points
        if (params.usePivots) {
            const pivots = detectPivots(high, low, params.pivotLookback);
            const pivotHighs: (number | null)[] = new Array(cleanData.length).fill(null);
            const pivotLows: (number | null)[] = new Array(cleanData.length).fill(null);
            pivots.forEach(p => {
                if (p.type === 'high') pivotHighs[p.index] = p.price;
                else pivotLows[p.index] = p.price;
            });
            indicators.push({ name: 'Pivot Highs', type: 'line', values: pivotHighs, color: COLORS.pivotHigh });
            indicators.push({ name: 'Pivot Lows', type: 'line', values: pivotLows, color: COLORS.pivotLow });
        }

        return indicators;
    }
};
