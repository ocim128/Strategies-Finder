import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createSignalLoop } from '../strategy-helpers';
import { calculateEMA, calculateSMA } from '../indicators';
import { COLORS } from '../constants';

// ============================================================================
// MACD-X Overlay Strategy - Enhanced MACD with Multiple Calculation Methods
// ============================================================================
// Inspired by MACD-X Overlay by DGT, with significant enhancements:
// - Multiple MACD calculation methods (Traditional, Histogram, Leader, Source)
// - Divergence detection for stronger signals
// - Histogram momentum analysis for early entries
// - Trend filter using EMA for signal confirmation
// - Signal strength scoring based on multiple factors
// ============================================================================

type MaType = 'EMA' | 'SMA';
type MacdType = 'traditional' | 'histogram' | 'leader' | 'source';

/**
 * Calculate moving average based on type
 */
function calculateMA(data: number[], period: number, type: MaType): (number | null)[] {
    return type === 'EMA' ? calculateEMA(data, period) : calculateSMA(data, period);
}

/**
 * Calculate MACD using different methods
 */
function calculateMACDX(
    closes: number[],
    fastPeriod: number,
    slowPeriod: number,
    signalPeriod: number,
    maType: MaType,
    macdType: MacdType
): {
    macd: (number | null)[];
    signal: (number | null)[];
    histogram: (number | null)[];
    fastMA: (number | null)[];
    slowMA: (number | null)[];
} {
    const fastMA = calculateMA(closes, fastPeriod, maType);
    const slowMA = calculateMA(closes, slowPeriod, maType);

    // Calculate base MACD line
    let macd: (number | null)[] = new Array(closes.length).fill(null);

    for (let i = 0; i < closes.length; i++) {
        const f = fastMA[i];
        const s = slowMA[i];
        if (f !== null && s !== null) {
            macd[i] = f - s;
        }
    }

    // Apply MACD type transformation
    switch (macdType) {
        case 'histogram': {
            // MACD-AS: Use histogram as MACD (more responsive)
            const tempSignal = calculateMACDSignal(macd, signalPeriod, maType);
            const tempMacd: (number | null)[] = new Array(closes.length).fill(null);
            for (let i = 0; i < closes.length; i++) {
                if (macd[i] !== null && tempSignal[i] !== null) {
                    tempMacd[i] = macd[i]! - tempSignal[i]!;
                }
            }
            macd = tempMacd;
            break;
        }
        case 'leader': {
            // MACD-Leader: More responsive by adding delta from source
            const fastDelta = calculateMA(
                closes.map((c, i) => fastMA[i] !== null ? c - fastMA[i]! : 0),
                fastPeriod,
                maType
            );
            const slowDelta = calculateMA(
                closes.map((c, i) => slowMA[i] !== null ? c - slowMA[i]! : 0),
                slowPeriod,
                maType
            );
            for (let i = 0; i < closes.length; i++) {
                if (macd[i] !== null && fastDelta[i] !== null && slowDelta[i] !== null) {
                    macd[i] = macd[i]! + fastDelta[i]! - slowDelta[i]!;
                }
            }
            break;
        }
        case 'source': {
            // MACD-Source: Based on average of fast/slow MAs
            const avgMA: number[] = closes.map((_, i) => {
                const f = fastMA[i];
                const s = slowMA[i];
                return (f !== null && s !== null) ? (f + s) / 2 : 0;
            });
            const sourceDelta = closes.map((c, i) => c - avgMA[i]);
            macd = calculateMA(sourceDelta, signalPeriod, maType);
            break;
        }
        // 'traditional' - no modification needed
    }

    // Calculate signal line
    const signal = calculateMACDSignal(macd, signalPeriod, maType);

    // Calculate histogram
    const histogram: (number | null)[] = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
        if (macd[i] !== null && signal[i] !== null) {
            histogram[i] = macd[i]! - signal[i]!;
        }
    }

    return { macd, signal, histogram, fastMA, slowMA };
}

/**
 * Calculate MACD signal line
 */
function calculateMACDSignal(macd: (number | null)[], period: number, maType: MaType): (number | null)[] {
    const signal: (number | null)[] = new Array(macd.length).fill(null);
    const multiplier = 2 / (period + 1);

    let validCount = 0;
    let initSum = 0;
    let prevSignal: number | null = null;

    for (let i = 0; i < macd.length; i++) {
        const m = macd[i];
        if (m === null) continue;

        if (prevSignal === null) {
            initSum += m;
            validCount++;
            if (validCount === period) {
                prevSignal = initSum / period;
                signal[i] = prevSignal;
            }
        } else {
            if (maType === 'EMA') {
                const currentSignal: number = (m - prevSignal) * multiplier + prevSignal;
                signal[i] = currentSignal;
                prevSignal = currentSignal;
            } else {
                // SMA signal
                let sum = 0;
                let count = 0;
                for (let j = i; j > i - period && j >= 0; j--) {
                    if (macd[j] !== null) {
                        sum += macd[j]!;
                        count++;
                    }
                }
                signal[i] = count > 0 ? sum / count : null;
            }
        }
    }

    return signal;
}

/**
 * Detect divergences between price and MACD
 */
function detectDivergence(
    highs: number[],
    lows: number[],
    macd: (number | null)[],
    lookback: number,
    index: number
): 'bullish' | 'bearish' | null {
    if (index < lookback + 2) return null;

    // Find local extremes in price and MACD
    let priceHigher = false;
    let priceLower = false;
    let macdHigher = false;
    let macdLower = false;

    const currentMacd = macd[index];
    const prevMacd = macd[index - lookback];

    if (currentMacd === null || prevMacd === null) return null;

    // Check price highs (for bearish divergence)
    const currentHigh = highs[index];
    let prevHigh = highs[index - lookback];
    for (let i = index - lookback; i < index - 1; i++) {
        if (highs[i] > prevHigh) prevHigh = highs[i];
    }
    priceHigher = currentHigh > prevHigh;
    macdLower = currentMacd < prevMacd;

    // Check price lows (for bullish divergence)
    const currentLow = lows[index];
    let prevLow = lows[index - lookback];
    for (let i = index - lookback; i < index - 1; i++) {
        if (lows[i] < prevLow) prevLow = lows[i];
    }
    priceLower = currentLow < prevLow;
    macdHigher = currentMacd > prevMacd;

    // Bearish divergence: Price makes higher high, MACD makes lower high
    if (priceHigher && macdLower) return 'bearish';

    // Bullish divergence: Price makes lower low, MACD makes higher low
    if (priceLower && macdHigher) return 'bullish';

    return null;
}

/**
 * Calculate histogram momentum (acceleration)
 */
function calculateHistogramMomentum(histogram: (number | null)[]): (number | null)[] {
    const momentum: (number | null)[] = new Array(histogram.length).fill(null);

    for (let i = 1; i < histogram.length; i++) {
        if (histogram[i] !== null && histogram[i - 1] !== null) {
            momentum[i] = histogram[i]! - histogram[i - 1]!;
        }
    }

    return momentum;
}

/**
 * Get histogram color based on value and momentum
 */
function getHistogramState(hist: number, prevHist: number): 'strong_bull' | 'weak_bull' | 'weak_bear' | 'strong_bear' {
    if (hist >= 0) {
        return hist > prevHist ? 'strong_bull' : 'weak_bull';
    } else {
        return hist < prevHist ? 'strong_bear' : 'weak_bear';
    }
}

// MACD type mapping for parameters
const MACD_TYPE_MAP: { [key: number]: MacdType } = {
    0: 'traditional',
    1: 'histogram',
    2: 'leader',
    3: 'source'
};

export const macd_x_overlay: Strategy = {
    name: 'MACD-X Overlay',
    description: 'Enhanced MACD with multiple calculation methods, divergence detection, and histogram momentum analysis',
    defaultParams: {
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        macdType: 0,           // 0=Traditional, 1=Histogram, 2=Leader, 3=Source
        useTrendFilter: 1,     // Toggle: 0=off, 1=on
        trendPeriod: 50,       // EMA period for trend filter
        useDivergence: 1,      // Toggle: 0=off, 1=on
        divergenceLookback: 14,
        useHistogramMomentum: 1, // Toggle: 0=off, 1=on
        confirmBars: 1         // Bars to confirm signal
    },
    paramLabels: {
        fastPeriod: 'Fast Period',
        slowPeriod: 'Slow Period',
        signalPeriod: 'Signal Period',
        macdType: 'MACD Type (0=Trad, 1=Hist, 2=Lead, 3=Src)',
        useTrendFilter: 'Use Trend Filter',
        trendPeriod: 'Trend EMA Period',
        useDivergence: 'Use Divergence',
        divergenceLookback: 'Divergence Lookback',
        useHistogramMomentum: 'Use Histogram Momentum',
        confirmBars: 'Confirmation Bars'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const highs = data.map(d => d.high);
        const lows = data.map(d => d.low);

        const macdTypeValue = MACD_TYPE_MAP[params.macdType] || 'traditional';

        const { macd, signal, histogram } = calculateMACDX(
            closes,
            params.fastPeriod,
            params.slowPeriod,
            params.signalPeriod,
            'EMA',
            macdTypeValue
        );

        // Calculate trend filter if enabled
        const trendEMA = params.useTrendFilter === 1
            ? calculateEMA(closes, params.trendPeriod)
            : null;

        // Calculate histogram momentum
        const histMomentum = params.useHistogramMomentum === 1
            ? calculateHistogramMomentum(histogram)
            : null;

        // Build indicators array for null check
        const indicators: (number | null)[][] = [macd, signal, histogram];
        if (trendEMA) indicators.push(trendEMA);

        return createSignalLoop(data, indicators, (i) => {
            const currentMacd = macd[i]!;
            const currentSignal = signal[i]!;
            const prevMacd = macd[i - 1]!;
            const prevSignal = signal[i - 1]!;
            const currentHist = histogram[i]!;
            const prevHist = histogram[i - 1]!;

            // Check for MACD/Signal crossover
            const bullishCross = prevMacd <= prevSignal && currentMacd > currentSignal;
            const bearishCross = prevMacd >= prevSignal && currentMacd < currentSignal;

            // Trend filter check
            let trendAllowsBuy = true;
            let trendAllowsSell = true;
            if (trendEMA && params.useTrendFilter === 1) {
                const trend = trendEMA[i];
                if (trend !== null) {
                    trendAllowsBuy = closes[i] > trend;
                    trendAllowsSell = closes[i] < trend;
                }
            }

            // Histogram momentum check
            let histMomentumBullish = true;
            let histMomentumBearish = true;
            if (histMomentum && params.useHistogramMomentum === 1 && histMomentum[i] !== null) {
                const mom = histMomentum[i]!;
                histMomentumBullish = mom > 0;
                histMomentumBearish = mom < 0;
            }

            // Divergence check
            let divergenceSignal: 'bullish' | 'bearish' | null = null;
            if (params.useDivergence === 1) {
                divergenceSignal = detectDivergence(highs, lows, macd, params.divergenceLookback, i);
            }

            // Get histogram state
            const histState = getHistogramState(currentHist, prevHist);

            // Signal confirmation
            const confirmBars = params.confirmBars || 1;
            let confirmedBullish = bullishCross;
            let confirmedBearish = bearishCross;

            if (confirmBars > 1 && i >= confirmBars) {
                // Check if cross happened within confirmBars ago and still valid
                for (let j = 1; j < confirmBars && j <= i; j++) {
                    const mj = macd[i - j];
                    const sj = signal[i - j];
                    if (mj !== null && sj !== null) {
                        if (bullishCross && mj <= sj) confirmedBullish = false;
                        if (bearishCross && mj >= sj) confirmedBearish = false;
                    }
                }
            }

            // Build reasons
            const buildReason = (type: 'buy' | 'sell'): string => {
                const reasons: string[] = [];
                reasons.push(`MACD-X ${macdTypeValue.toUpperCase()}`);

                if (type === 'buy') {
                    reasons.push('Bullish Cross');
                    if (divergenceSignal === 'bullish') reasons.push('+ Bullish Divergence');
                    if (histMomentumBullish) reasons.push('+ Rising Momentum');
                    if (histState === 'strong_bull') reasons.push('+ Strong Histogram');
                } else {
                    reasons.push('Bearish Cross');
                    if (divergenceSignal === 'bearish') reasons.push('+ Bearish Divergence');
                    if (histMomentumBearish) reasons.push('+ Falling Momentum');
                    if (histState === 'strong_bear') reasons.push('+ Strong Histogram');
                }

                return reasons.join(' ');
            };

            // Generate signals
            // Buy signal: Bullish cross with confirmations
            if (confirmedBullish && trendAllowsBuy) {
                // Boost signal if we have divergence confirmation
                if (divergenceSignal === 'bullish' || histMomentumBullish || histState === 'strong_bull') {
                    return {
                        time: data[i].time,
                        type: 'buy',
                        price: data[i].close,
                        reason: buildReason('buy')
                    };
                }
                // Standard cross signal
                return {
                    time: data[i].time,
                    type: 'buy',
                    price: data[i].close,
                    reason: buildReason('buy')
                };
            }

            // Sell signal: Bearish cross with confirmations
            if (confirmedBearish && trendAllowsSell) {
                if (divergenceSignal === 'bearish' || histMomentumBearish || histState === 'strong_bear') {
                    return {
                        time: data[i].time,
                        type: 'sell',
                        price: data[i].close,
                        reason: buildReason('sell')
                    };
                }
                return {
                    time: data[i].time,
                    type: 'sell',
                    price: data[i].close,
                    reason: buildReason('sell')
                };
            }

            // Divergence-only signals (early warning)
            if (params.useDivergence === 1 && divergenceSignal) {
                if (divergenceSignal === 'bullish' && trendAllowsBuy && histMomentumBullish) {
                    return {
                        time: data[i].time,
                        type: 'buy',
                        price: data[i].close,
                        reason: 'Bullish Divergence (Early Warning)'
                    };
                }
                if (divergenceSignal === 'bearish' && trendAllowsSell && histMomentumBearish) {
                    return {
                        time: data[i].time,
                        type: 'sell',
                        price: data[i].close,
                        reason: 'Bearish Divergence (Early Warning)'
                    };
                }
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        const macdTypeValue = MACD_TYPE_MAP[params.macdType] || 'traditional';

        const { macd, signal, histogram } = calculateMACDX(
            closes,
            params.fastPeriod,
            params.slowPeriod,
            params.signalPeriod,
            'EMA',
            macdTypeValue
        );

        const indicators: StrategyIndicator[] = [
            { name: 'MACD-X', type: 'line', values: macd, color: COLORS.Fast },
            { name: 'Signal', type: 'line', values: signal, color: COLORS.Slow },
            { name: 'Histogram', type: 'histogram', values: histogram, color: COLORS.Histogram }
        ];

        // Add trend EMA if enabled
        if (params.useTrendFilter === 1) {
            const trendEMA = calculateEMA(closes, params.trendPeriod);
            indicators.push({
                name: 'Trend EMA',
                type: 'line',
                values: trendEMA,
                color: COLORS.Trend
            });
        }

        return indicators;
    }
};
