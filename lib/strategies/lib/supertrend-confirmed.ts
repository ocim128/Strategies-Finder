import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { COLORS } from '../constants';

function calculateAtrWilder(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    const atr: (number | null)[] = [];
    let initialTRSum = 0;

    for (let i = 0; i < close.length; i++) {
        const tr = i === 0
            ? high[i] - low[i]
            : Math.max(
                high[i] - low[i],
                Math.abs(high[i] - close[i - 1]),
                Math.abs(low[i] - close[i - 1])
            );

        if (i < period - 1) {
            initialTRSum += tr;
            atr.push(null);
        } else if (i === period - 1) {
            initialTRSum += tr;
            atr.push(initialTRSum / period);
        } else {
            const prevATR = atr[i - 1] ?? 0;
            atr.push((prevATR * (period - 1) + tr) / period);
        }
    }

    return atr;
}

function calculateAtrSma(
    high: number[],
    low: number[],
    close: number[],
    period: number
): (number | null)[] {
    const atr: (number | null)[] = [];
    let sum = 0;

    for (let i = 0; i < close.length; i++) {
        const tr = i === 0
            ? high[i] - low[i]
            : Math.max(
                high[i] - low[i],
                Math.abs(high[i] - close[i - 1]),
                Math.abs(low[i] - close[i - 1])
            );

        sum += tr;

        if (i < period - 1) {
            atr.push(null);
            continue;
        }

        if (i >= period) {
            const trToRemove = i - period >= 0 ? (
                i - period === 0
                    ? high[0] - low[0]
                    : Math.max(
                        high[i - period] - low[i - period],
                        Math.abs(high[i - period] - close[i - period - 1]),
                        Math.abs(low[i - period] - close[i - period - 1])
                    )
            ) : 0;
            sum -= trToRemove;
        }

        atr.push(sum / period);
    }

    return atr;
}

function calculateSupertrendCustom(
    high: number[],
    low: number[],
    close: number[],
    period: number,
    multiplier: number,
    useSmaAtr: boolean
): { supertrend: (number | null)[]; direction: (1 | -1 | null)[] } {
    const atr = useSmaAtr
        ? calculateAtrSma(high, low, close, period)
        : calculateAtrWilder(high, low, close, period);

    const supertrend: (number | null)[] = [];
    const direction: (1 | -1 | null)[] = [];

    let prevFinalUpper = 0;
    let prevFinalLower = 0;
    let prevTrend: 1 | -1 = 1;

    for (let i = 0; i < close.length; i++) {
        if (atr[i] === null) {
            supertrend.push(null);
            direction.push(null);
            continue;
        }

        const hl2 = (high[i] + low[i]) / 2;
        const basicUpper = hl2 + multiplier * atr[i]!;
        const basicLower = hl2 - multiplier * atr[i]!;

        if (supertrend.length > 0 && supertrend[i - 1] === null) {
            supertrend.push(basicLower);
            direction.push(1);
            prevFinalUpper = basicUpper;
            prevFinalLower = basicLower;
            prevTrend = 1;
            continue;
        }

        const prevClose = close[i - 1];

        const finalUpper = (basicUpper < prevFinalUpper || prevClose > prevFinalUpper)
            ? basicUpper
            : prevFinalUpper;
        const finalLower = (basicLower > prevFinalLower || prevClose < prevFinalLower)
            ? basicLower
            : prevFinalLower;

        let currentTrend: 1 | -1 = prevTrend;
        if (prevTrend === 1 && close[i] < finalLower) {
            currentTrend = -1;
        } else if (prevTrend === -1 && close[i] > finalUpper) {
            currentTrend = 1;
        }

        direction.push(currentTrend);
        supertrend.push(currentTrend === 1 ? finalLower : finalUpper);

        prevFinalUpper = finalUpper;
        prevFinalLower = finalLower;
        prevTrend = currentTrend;
    }

    return { supertrend, direction };
}

export const supertrend_confirmed: Strategy = {
    name: 'SuperTrend Confirmed Entry',
    description: 'Classic SuperTrend flips with optional SMA(TR) ATR and cooldown for finder-friendly tuning.',
    defaultParams: {
        period: 10,
        multiplier: 3,
        useSmaAtr: 0,
        useCooldown: 0,
        cooldownBars: 3
    },
    paramLabels: {
        period: 'ATR Period',
        multiplier: 'ATR Multiplier',
        useSmaAtr: 'Use SMA(TR) ATR',
        useCooldown: 'Use Cooldown',
        cooldownBars: 'Cooldown Bars'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const period = Math.max(1, Math.round(params.period ?? 10));
        const multiplier = Math.max(0, params.multiplier ?? 3);
        const useSmaAtr = params.useSmaAtr === 1;
        const useCooldown = params.useCooldown === 1;
        const cooldownBars = Math.max(1, Math.round(params.cooldownBars ?? 3));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { direction } = calculateSupertrendCustom(highs, lows, closes, period, multiplier, useSmaAtr);

        let lastBuyIndex = -Infinity;
        let lastSellIndex = -Infinity;

        return createSignalLoop(cleanData, [direction], (i) => {
            if (direction[i - 1] === -1 && direction[i] === 1) {
                if (!useCooldown || i - lastBuyIndex > cooldownBars) {
                    lastBuyIndex = i;
                    return createBuySignal(cleanData, i, 'SuperTrend Buy Flip');
                }
            } else if (direction[i - 1] === 1 && direction[i] === -1) {
                if (!useCooldown || i - lastSellIndex > cooldownBars) {
                    lastSellIndex = i;
                    return createSellSignal(cleanData, i, 'SuperTrend Sell Flip');
                }
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const period = Math.max(1, Math.round(params.period ?? 10));
        const multiplier = Math.max(0, params.multiplier ?? 3);
        const useSmaAtr = params.useSmaAtr === 1;

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { supertrend } = calculateSupertrendCustom(highs, lows, closes, period, multiplier, useSmaAtr);

        return [
            { name: 'Supertrend', type: 'line', values: supertrend, color: COLORS.Trend }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both'
    }
};
