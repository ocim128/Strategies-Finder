import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateSMA } from '../indicators';
import { COLORS } from '../constants';

type TrendState = 'bullish' | 'bearish' | 'neutral';

interface ResolvedParams {
    signalMode: number;
    confirmationBars: number;
    sensitivity: number;
    atrMultiplier: number;
    atrPeriod: number;
    percentThreshold: number;
    absoluteThreshold: number;
    calcMethod: number;
    averageLength: number;
    breakoutMode: number;
    trendFilter: number;
    emaFast: number;
    emaMid: number;
    emaSlow: number;
}

interface ReversalState {
    signals: Signal[];
    emaFast: (number | null)[];
    emaMid: (number | null)[];
    emaSlow: (number | null)[];
    pivotHighLevel: (number | null)[];
    pivotLowLevel: (number | null)[];
}

interface ScheduledSignal {
    type: 'buy' | 'sell';
    reason: string;
}

const SENSITIVITY_PRESETS: Record<number, number> = {
    1: 0.8, // Very High
    2: 1.2, // High
    3: 2.0, // Medium
    4: 2.8, // Low
    5: 3.5, // Very Low
};

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveParams(params: StrategyParams): ResolvedParams {
    const sensitivity = clampInt(params.sensitivity ?? 3, 0, 5);
    const atrPeriod = Math.max(2, Math.floor(params.atrPeriod ?? 14));
    const customAtrMultiplier = Math.max(0.1, params.atrMultiplier ?? 2.0);
    const atrMultiplier = SENSITIVITY_PRESETS[sensitivity] ?? customAtrMultiplier;

    return {
        signalMode: clampInt(params.signalMode ?? 0, 0, 2),
        confirmationBars: Math.max(0, Math.floor(params.confirmationBars ?? 0)),
        sensitivity,
        atrMultiplier,
        atrPeriod,
        percentThreshold: Math.max(0, params.percentThreshold ?? 0.1),
        absoluteThreshold: Math.max(0, params.absoluteThreshold ?? 0),
        calcMethod: clampInt(params.calcMethod ?? 0, 0, 1),
        averageLength: Math.max(1, Math.floor(params.averageLength ?? 5)),
        breakoutMode: clampInt(params.breakoutMode ?? 0, 0, 1),
        trendFilter: clampInt(params.trendFilter ?? 0, 0, 1),
        emaFast: Math.max(2, Math.floor(params.emaFast ?? 9)),
        emaMid: Math.max(2, Math.floor(params.emaMid ?? 14)),
        emaSlow: Math.max(2, Math.floor(params.emaSlow ?? 21)),
    };
}

function buildSmoothedSeries(values: number[], period: number): number[] {
    if (period <= 1) return values;
    const smoothed = calculateSMA(values, period);
    return values.map((val, idx) => smoothed[idx] ?? val);
}

function getTrendState(
    emaFast: number | null,
    emaMid: number | null,
    emaSlow: number | null,
    close: number
): TrendState {
    if (emaFast === null || emaMid === null || emaSlow === null) return 'neutral';

    if (emaFast > emaMid && emaMid > emaSlow && close > emaFast) {
        return 'bullish';
    }
    if (emaFast < emaMid && emaMid < emaSlow && close < emaFast) {
        return 'bearish';
    }
    return 'neutral';
}

function buildSignalReason(type: 'buy' | 'sell', trend: TrendState, preview: boolean): string {
    const direction = type === 'buy' ? 'Bullish' : 'Bearish';
    const isStrong = (type === 'buy' && trend === 'bullish') || (type === 'sell' && trend === 'bearish');
    const strength = isStrong ? 'Strong ' : '';
    const suffix = preview ? 'preview' : 'reversal';
    return `Reversal Pro ${strength}${direction} ${suffix}`;
}

function computeThreshold(
    index: number,
    atr: (number | null)[],
    closes: number[],
    atrMultiplier: number,
    percentThreshold: number,
    absoluteThreshold: number
): number | null {
    const atrVal = atr[index];
    if (atrVal === null || atrVal <= 0) return null;
    const close = closes[index];
    const percentComponent = close > 0 ? close * (percentThreshold / 100) : 0;
    return Math.max(atrVal * atrMultiplier, percentComponent, absoluteThreshold);
}

function computeReversalState(
    data: OHLCVData[],
    params: StrategyParams,
    includeSignals: boolean
): ReversalState {
    const resolved = resolveParams(params);
    const length = data.length;

    const highsRaw = getHighs(data);
    const lowsRaw = getLows(data);
    const closes = getCloses(data);

    const emaFast = calculateEMA(closes, resolved.emaFast);
    const emaMid = calculateEMA(closes, resolved.emaMid);
    const emaSlow = calculateEMA(closes, resolved.emaSlow);
    const atr = calculateATR(highsRaw, lowsRaw, closes, resolved.atrPeriod);

    const highs = resolved.calcMethod === 1 && resolved.averageLength > 1
        ? buildSmoothedSeries(highsRaw, resolved.averageLength)
        : highsRaw;
    const lows = resolved.calcMethod === 1 && resolved.averageLength > 1
        ? buildSmoothedSeries(lowsRaw, resolved.averageLength)
        : lowsRaw;

    const trendState: TrendState[] = new Array(length).fill('neutral');
    for (let i = 0; i < length; i++) {
        trendState[i] = getTrendState(emaFast[i], emaMid[i], emaSlow[i], closes[i]);
    }

    const pivotHighLevel: (number | null)[] = new Array(length).fill(null);
    const pivotLowLevel: (number | null)[] = new Array(length).fill(null);

    const signals: Signal[] = [];
    const scheduledSignals: ScheduledSignal[][] | null = includeSignals
        ? Array.from({ length }, () => [])
        : null;

    const includePreview = resolved.signalMode === 1 || resolved.signalMode === 2;
    const includeConfirmed = resolved.signalMode === 0 || resolved.signalMode === 2;

    const scheduleSignal = (index: number, type: 'buy' | 'sell', reason: string): void => {
        if (!includeSignals) return;
        const target = index + resolved.confirmationBars;
        if (target >= length) return;
        if (target === index) {
            signals.push(type === 'buy'
                ? createBuySignal(data, index, reason)
                : createSellSignal(data, index, reason));
            return;
        }
        scheduledSignals?.[target].push({ type, reason });
    };

    const allowSignal = (type: 'buy' | 'sell', index: number): boolean => {
        if (resolved.trendFilter === 0) return true;
        const trend = trendState[index];
        return type === 'buy' ? trend === 'bullish' : trend === 'bearish';
    };

    let direction: -1 | 0 | 1 = 0;
    let candidateHigh = highs[0];
    let candidateHighIndex = 0;
    let candidateLow = lows[0];
    let candidateLowIndex = 0;

    let lastConfirmedHigh: { price: number; index: number } | null = null;
    let lastConfirmedLow: { price: number; index: number } | null = null;

    let pendingBullish = false;
    let pendingBearish = false;
    let pendingBullishLevel: number | null = null;
    let pendingBearishLevel: number | null = null;

    let currentHighLevel: number | null = null;
    let currentLowLevel: number | null = null;

    for (let i = 1; i < length; i++) {
        if (includeSignals && scheduledSignals) {
            const scheduled = scheduledSignals[i];
            if (scheduled.length > 0) {
                for (const signal of scheduled) {
                    signals.push(signal.type === 'buy'
                        ? createBuySignal(data, i, signal.reason)
                        : createSellSignal(data, i, signal.reason));
                }
            }
        }

        if (direction >= 0 && highs[i] >= candidateHigh) {
            candidateHigh = highs[i];
            candidateHighIndex = i;
        }
        if (direction <= 0 && lows[i] <= candidateLow) {
            candidateLow = lows[i];
            candidateLowIndex = i;
        }

        const threshold = computeThreshold(
            i,
            atr,
            closes,
            resolved.atrMultiplier,
            resolved.percentThreshold,
            resolved.absoluteThreshold
        );

        if (threshold !== null) {
            if (direction === 0) {
                const upMove = highs[i] - candidateLow;
                const downMove = candidateHigh - lows[i];
                if (upMove >= threshold || downMove >= threshold) {
                    if (upMove >= downMove) {
                        lastConfirmedLow = { price: candidateLow, index: candidateLowIndex };
                        currentLowLevel = lastConfirmedLow.price;
                        pendingBullish = lastConfirmedHigh !== null;
                        pendingBullishLevel = lastConfirmedHigh?.price ?? null;
                        pendingBearish = false;
                        pendingBearishLevel = null;
                        direction = 1;
                        candidateHigh = highs[i];
                        candidateHighIndex = i;

                        if (includeSignals && includePreview && allowSignal('buy', i)) {
                            signals.push(createBuySignal(data, i, buildSignalReason('buy', trendState[i], true)));
                        }
                    } else {
                        lastConfirmedHigh = { price: candidateHigh, index: candidateHighIndex };
                        currentHighLevel = lastConfirmedHigh.price;
                        pendingBearish = lastConfirmedLow !== null;
                        pendingBearishLevel = lastConfirmedLow?.price ?? null;
                        pendingBullish = false;
                        pendingBullishLevel = null;
                        direction = -1;
                        candidateLow = lows[i];
                        candidateLowIndex = i;

                        if (includeSignals && includePreview && allowSignal('sell', i)) {
                            signals.push(createSellSignal(data, i, buildSignalReason('sell', trendState[i], true)));
                        }
                    }
                }
            } else if (direction === 1) {
                if (candidateHigh - lows[i] >= threshold) {
                    lastConfirmedHigh = { price: candidateHigh, index: candidateHighIndex };
                    currentHighLevel = lastConfirmedHigh.price;
                    pendingBearish = lastConfirmedLow !== null;
                    pendingBearishLevel = lastConfirmedLow?.price ?? null;
                    pendingBullish = false;
                    pendingBullishLevel = null;
                    direction = -1;
                    candidateLow = lows[i];
                    candidateLowIndex = i;

                    if (includeSignals && includePreview && allowSignal('sell', i)) {
                        signals.push(createSellSignal(data, i, buildSignalReason('sell', trendState[i], true)));
                    }
                }
            } else if (direction === -1) {
                if (highs[i] - candidateLow >= threshold) {
                    lastConfirmedLow = { price: candidateLow, index: candidateLowIndex };
                    currentLowLevel = lastConfirmedLow.price;
                    pendingBullish = lastConfirmedHigh !== null;
                    pendingBullishLevel = lastConfirmedHigh?.price ?? null;
                    pendingBearish = false;
                    pendingBearishLevel = null;
                    direction = 1;
                    candidateHigh = highs[i];
                    candidateHighIndex = i;

                    if (includeSignals && includePreview && allowSignal('buy', i)) {
                        signals.push(createBuySignal(data, i, buildSignalReason('buy', trendState[i], true)));
                    }
                }
            }
        }

        if (includeSignals && includeConfirmed) {
            if (pendingBullish && pendingBullishLevel !== null) {
                const broke = resolved.breakoutMode === 1
                    ? highs[i] > pendingBullishLevel
                    : closes[i] > pendingBullishLevel;
                if (broke) {
                    if (allowSignal('buy', i)) {
                        scheduleSignal(i, 'buy', buildSignalReason('buy', trendState[i], false));
                    }
                    pendingBullish = false;
                    pendingBullishLevel = null;
                }
            }

            if (pendingBearish && pendingBearishLevel !== null) {
                const broke = resolved.breakoutMode === 1
                    ? lows[i] < pendingBearishLevel
                    : closes[i] < pendingBearishLevel;
                if (broke) {
                    if (allowSignal('sell', i)) {
                        scheduleSignal(i, 'sell', buildSignalReason('sell', trendState[i], false));
                    }
                    pendingBearish = false;
                    pendingBearishLevel = null;
                }
            }
        }

        pivotHighLevel[i] = currentHighLevel;
        pivotLowLevel[i] = currentLowLevel;
    }

    return { signals, emaFast, emaMid, emaSlow, pivotHighLevel, pivotLowLevel };
}

export const reversal_detection_pro: Strategy = {
    name: 'Reversal Detection Pro',
    description: 'ATR-adaptive zigzag reversals with triple EMA trend context and structural confirmation',
    defaultParams: {
        signalMode: 0,
        confirmationBars: 0,
        sensitivity: 3,
        atrMultiplier: 2.0,
        atrPeriod: 14,
        percentThreshold: 0.1,
        absoluteThreshold: 0,
        calcMethod: 0,
        averageLength: 5,
        breakoutMode: 0,
        trendFilter: 0,
        emaFast: 9,
        emaMid: 14,
        emaSlow: 21,
    },
    paramLabels: {
        signalMode: 'Signal Mode (0=Confirmed,1=Preview,2=Both)',
        confirmationBars: 'Extra Confirmation Bars',
        sensitivity: 'Sensitivity Preset (0=Custom,1=VHigh..5=VLow)',
        atrMultiplier: 'ATR Multiplier (Custom)',
        atrPeriod: 'ATR Period',
        percentThreshold: 'Percent Threshold (%)',
        absoluteThreshold: 'Absolute Threshold',
        calcMethod: 'Price Method (0=High/Low,1=Average)',
        averageLength: 'Average Length',
        breakoutMode: 'Breakout Mode (0=Close,1=Wick)',
        trendFilter: 'Trend Filter (0=Off,1=Aligned)',
        emaFast: 'EMA Fast',
        emaMid: 'EMA Mid',
        emaSlow: 'EMA Slow',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 3) return [];
        return computeReversalState(cleanData, params, true).signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const { emaFast, emaMid, emaSlow, pivotHighLevel, pivotLowLevel } = computeReversalState(cleanData, params, false);

        return [
            { name: 'EMA Fast', type: 'line', values: emaFast, color: COLORS.Fast },
            { name: 'EMA Mid', type: 'line', values: emaMid, color: COLORS.Slow },
            { name: 'EMA Slow', type: 'line', values: emaSlow, color: COLORS.Neutral },
            { name: 'Pivot High Level', type: 'line', values: pivotHighLevel, color: COLORS.Trend },
            { name: 'Pivot Low Level', type: 'line', values: pivotLowLevel, color: COLORS.Positive },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};
