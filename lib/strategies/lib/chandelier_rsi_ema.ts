import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateRSI } from '../indicators';
import { COLORS } from '../constants';

function calculateRollingExtreme(values: number[], period: number, mode: 'max' | 'min'): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    const deque: number[] = [];

    for (let i = 0; i < values.length; i++) {
        const val = values[i];
        while (deque.length > 0) {
            const lastIdx = deque[deque.length - 1];
            if (mode === 'max') {
                if (values[lastIdx] <= val) deque.pop();
                else break;
            } else {
                if (values[lastIdx] >= val) deque.pop();
                else break;
            }
        }
        deque.push(i);

        const windowStart = i - period + 1;
        while (deque.length > 0 && deque[0] < windowStart) deque.shift();

        if (i >= period - 1) {
            result[i] = values[deque[0]];
        }
    }

    return result;
}

function calculateChandelierExit(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number,
    multiplier: number
): {
    longStop: (number | null)[];
    shortStop: (number | null)[];
    direction: (1 | -1 | null)[];
} {
    const atr = calculateATR(highs, lows, closes, period);
    const highestHigh = calculateRollingExtreme(highs, period, 'max');
    const lowestLow = calculateRollingExtreme(lows, period, 'min');

    const longStop: (number | null)[] = new Array(closes.length).fill(null);
    const shortStop: (number | null)[] = new Array(closes.length).fill(null);
    const direction: (1 | -1 | null)[] = new Array(closes.length).fill(null);

    let prevDir: 1 | -1 = 1;

    for (let i = 0; i < closes.length; i++) {
        const atrVal = atr[i];
        const highest = highestHigh[i];
        const lowest = lowestLow[i];

        if (atrVal === null || highest === null || lowest === null) {
            longStop[i] = null;
            shortStop[i] = null;
            direction[i] = null;
            continue;
        }

        const atrScaled = atrVal * multiplier;
        const baseLong = highest - atrScaled;
        const baseShort = lowest + atrScaled;

        if (i === 0 || longStop[i - 1] === null || shortStop[i - 1] === null) {
            longStop[i] = baseLong;
            shortStop[i] = baseShort;
            direction[i] = prevDir;
            continue;
        }

        const longPrev = longStop[i - 1]!;
        const shortPrev = shortStop[i - 1]!;
        const prevClose = closes[i - 1];

        const adjLong = prevClose > longPrev ? Math.max(baseLong, longPrev) : baseLong;
        const adjShort = prevClose < shortPrev ? Math.min(baseShort, shortPrev) : baseShort;

        longStop[i] = adjLong;
        shortStop[i] = adjShort;

        let dir = prevDir;
        if (closes[i] > shortPrev) dir = 1;
        else if (closes[i] < longPrev) dir = -1;
        direction[i] = dir;
        prevDir = dir;
    }

    return { longStop, shortStop, direction };
}

export const chandelier_rsi_ema: Strategy = {
    name: 'Chandelier Exit + RSI + EMA',
    description: 'Chandelier Exit flips for signals with RSI fast/slow and EMA overlays.',
    defaultParams: {
        rsiFast: 25,
        rsiSlow: 100,
        emaPeriod: 50,
        atrPeriod: 1,
        atrMultiplier: 1.85
    },
    paramLabels: {
        rsiFast: 'RSI Fast',
        rsiSlow: 'RSI Slow',
        emaPeriod: 'EMA Period',
        atrPeriod: 'ATR Period',
        atrMultiplier: 'ATR Multiplier'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const atrPeriod = Math.max(1, Math.round(params.atrPeriod ?? 1));
        const atrMultiplier = Math.max(0.1, params.atrMultiplier ?? 1.85);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { direction } = calculateChandelierExit(highs, lows, closes, atrPeriod, atrMultiplier);

        return createSignalLoop(cleanData, [direction], (i) => {
            const prev = direction[i - 1];
            const curr = direction[i];
            if (prev === -1 && curr === 1) {
                return createBuySignal(cleanData, i, 'Chandelier Exit Buy');
            }
            if (prev === 1 && curr === -1) {
                return createSellSignal(cleanData, i, 'Chandelier Exit Sell');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const rsiFast = Math.max(1, Math.round(params.rsiFast ?? 25));
        const rsiSlow = Math.max(2, Math.round(params.rsiSlow ?? 100));
        const emaPeriod = Math.max(1, Math.round(params.emaPeriod ?? 50));
        const atrPeriod = Math.max(1, Math.round(params.atrPeriod ?? 1));
        const atrMultiplier = Math.max(0.1, params.atrMultiplier ?? 1.85);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { longStop, shortStop } = calculateChandelierExit(highs, lows, closes, atrPeriod, atrMultiplier);

        return [
            { name: 'Chandelier Long Stop', type: 'line', values: longStop, color: COLORS.Positive },
            { name: 'Chandelier Short Stop', type: 'line', values: shortStop, color: COLORS.Histogram },
            { name: 'EMA', type: 'line', values: calculateEMA(closes, emaPeriod), color: COLORS.Neutral },
            { name: 'RSI Slow', type: 'line', values: calculateRSI(closes, rsiSlow), color: COLORS.Slow },
            { name: 'RSI Fast', type: 'line', values: calculateRSI(closes, rsiFast), color: COLORS.Fast }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both'
    }
};
