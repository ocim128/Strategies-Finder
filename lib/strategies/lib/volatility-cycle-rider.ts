import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR } from '../indicators';
import { COLORS } from '../constants';

/**
 * Volatility Cycle Rider - Simplified Breakout Strategy
 * 
 * Ultra-simple version that WILL generate trades:
 * - Buy when price breaks above N-bar high
 * - Sell when price breaks below N-bar low
 * - Trail stop at X * ATR
 * 
 * This is a classic Donchian-style breakout with ATR trailing.
 */

const ATR_PERIOD = 14;

export const volatility_cycle_rider: Strategy = {
    name: 'Volatility Cycle Rider',
    description: 'Simple breakout strategy: enter on N-bar high/low break, exit on ATR trail',
    defaultParams: {
        breakoutPeriod: 20,    // N-bar high/low lookback
        trailAtr: 2.0,         // Trail stop in ATR units
    },
    paramLabels: {
        breakoutPeriod: 'Breakout Period',
        trailAtr: 'Trail ATR',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const breakoutPeriod = Math.max(5, Math.floor(params.breakoutPeriod));
        const trailAtr = Math.max(0.5, params.trailAtr ?? 2.0);

        const minBars = Math.max(breakoutPeriod, ATR_PERIOD) + 5;
        if (cleanData.length < minBars) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const atr = calculateATR(highs, lows, closes, ATR_PERIOD);

        // Calculate N-bar high/low (excluding current bar)
        const nBarHigh: (number | null)[] = new Array(cleanData.length).fill(null);
        const nBarLow: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = breakoutPeriod; i < cleanData.length; i++) {
            let high = -Infinity;
            let low = Infinity;
            // Look at bars [i - breakoutPeriod, i - 1] (exclude current bar)
            for (let j = i - breakoutPeriod; j < i; j++) {
                if (highs[j] > high) high = highs[j];
                if (lows[j] < low) low = lows[j];
            }
            nBarHigh[i] = high;
            nBarLow[i] = low;
        }

        const signals: Signal[] = [];
        let position: 'none' | 'long' | 'short' = 'none';
        let trailStop = 0;
        let peakPrice = 0;
        let troughPrice = 0;

        const startIndex = Math.max(breakoutPeriod, ATR_PERIOD) + 1;

        for (let i = startIndex; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const atrVal = atr[i];
            const prevHigh = nBarHigh[i];
            const prevLow = nBarLow[i];

            if (atrVal === null || prevHigh === null || prevLow === null) continue;
            if (!Number.isFinite(atrVal) || atrVal <= 0) continue;

            if (position === 'none') {
                // ENTRY: Simple breakout
                const breakUp = bar.close > prevHigh;
                const breakDown = bar.close < prevLow;

                if (breakUp) {
                    position = 'long';
                    peakPrice = bar.high;
                    trailStop = bar.close - atrVal * trailAtr;
                    signals.push(createBuySignal(cleanData, i, 'Breakout Long'));
                } else if (breakDown) {
                    position = 'short';
                    troughPrice = bar.low;
                    trailStop = bar.close + atrVal * trailAtr;
                    signals.push(createSellSignal(cleanData, i, 'Breakout Short'));
                }
            } else if (position === 'long') {
                // Update peak and trail
                if (bar.high > peakPrice) {
                    peakPrice = bar.high;
                    const newTrail = peakPrice - atrVal * trailAtr;
                    if (newTrail > trailStop) trailStop = newTrail;
                }

                // EXIT: Trail stop hit
                if (bar.low <= trailStop) {
                    signals.push(createSellSignal(cleanData, i, 'Trail Stop Long'));
                    position = 'none';
                    trailStop = 0;
                    peakPrice = 0;
                }
            } else if (position === 'short') {
                // Update trough and trail
                if (bar.low < troughPrice) {
                    troughPrice = bar.low;
                    const newTrail = troughPrice + atrVal * trailAtr;
                    if (newTrail < trailStop) trailStop = newTrail;
                }

                // EXIT: Trail stop hit
                if (bar.high >= trailStop) {
                    signals.push(createBuySignal(cleanData, i, 'Trail Stop Short'));
                    position = 'none';
                    trailStop = 0;
                    troughPrice = 0;
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const breakoutPeriod = Math.max(5, Math.floor(params.breakoutPeriod));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const atr = calculateATR(highs, lows, closes, ATR_PERIOD);

        const nBarHigh: (number | null)[] = new Array(cleanData.length).fill(null);
        const nBarLow: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = breakoutPeriod; i < cleanData.length; i++) {
            let high = -Infinity;
            let low = Infinity;
            for (let j = i - breakoutPeriod; j < i; j++) {
                if (highs[j] > high) high = highs[j];
                if (lows[j] < low) low = lows[j];
            }
            nBarHigh[i] = high;
            nBarLow[i] = low;
        }

        return [
            { name: 'Breakout High', type: 'line', values: nBarHigh, color: COLORS.Positive },
            { name: 'Breakout Low', type: 'line', values: nBarLow, color: COLORS.Histogram },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Neutral },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};
