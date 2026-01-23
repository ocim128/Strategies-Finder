import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';
import { COLORS } from '../constants';

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function calculateVolTargetedSeries(
    data: OHLCVData[],
    params: StrategyParams
): {
    fast: (number | null)[];
    slow: (number | null)[];
    atr: (number | null)[];
    atrPercent: (number | null)[];
    volScale: (number | null)[];
    scaledTrend: (number | null)[];
} {
    const closes = data.map(d => d.close);
    const highs = data.map(d => d.high);
    const lows = data.map(d => d.low);

    const fast = calculateEMA(closes, params.fastPeriod);
    const slow = calculateEMA(closes, params.slowPeriod);
    const atr = calculateATR(highs, lows, closes, params.atrPeriod);

    const atrPercent: (number | null)[] = new Array(data.length).fill(null);
    const volScale: (number | null)[] = new Array(data.length).fill(null);
    const scaledTrend: (number | null)[] = new Array(data.length).fill(null);

    const minScale = Math.max(0.01, params.minVolScale);
    const maxScale = Math.max(minScale, params.maxVolScale);
    const targetVol = Math.max(0.0001, params.targetVolPercent);

    for (let i = 0; i < data.length; i++) {
        const f = fast[i];
        const s = slow[i];
        const a = atr[i];
        const close = closes[i];

        if (f === null || s === null || a === null || a <= 0 || close <= 0) continue;

        const atrPct = (a / close) * 100;
        if (!Number.isFinite(atrPct) || atrPct <= 0) continue;

        atrPercent[i] = atrPct;

        const scaleRaw = targetVol / atrPct;
        const scale = clamp(scaleRaw, minScale, maxScale);
        volScale[i] = scale;

        const trend = (f - s) / a;
        scaledTrend[i] = trend * scale;
    }

    return { fast, slow, atr, atrPercent, volScale, scaledTrend };
}

export const vol_targeted_trend: Strategy = {
    name: 'Vol-Targeted Trend',
    description: 'Trend-following signals using ATR-normalized momentum scaled by a volatility target',
    defaultParams: {
        fastPeriod: 20,
        slowPeriod: 60,
        atrPeriod: 14,
        targetVolPercent: 1.5,
        minVolScale: 0.5,
        maxVolScale: 2.0,
        entryThreshold: 0.4,
        exitThreshold: 0.1
    },
    paramLabels: {
        fastPeriod: 'Fast EMA Period',
        slowPeriod: 'Slow EMA Period',
        atrPeriod: 'ATR Period',
        targetVolPercent: 'Target Volatility (%)',
        minVolScale: 'Min Vol Scale',
        maxVolScale: 'Max Vol Scale',
        entryThreshold: 'Entry Threshold (ATR units)',
        exitThreshold: 'Exit Threshold (ATR units)'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        const minBars = Math.max(params.fastPeriod, params.slowPeriod, params.atrPeriod) + 1;
        if (cleanData.length < minBars) return [];

        const { scaledTrend } = calculateVolTargetedSeries(cleanData, params);
        let position: 'long' | 'short' | null = null;

        return createSignalLoop(cleanData, [scaledTrend], (i) => {
            const prev = scaledTrend[i - 1]!;
            const curr = scaledTrend[i]!;
            const entry = Math.max(0, params.entryThreshold);
            const exit = Math.max(0, Math.min(params.exitThreshold, entry));

            if (position === 'long') {
                if (prev >= -entry && curr < -entry) {
                    position = 'short';
                    return createSellSignal(cleanData, i, 'Vol-targeted trend flip to short');
                }
                if (prev >= exit && curr < exit) {
                    position = null;
                    return createSellSignal(cleanData, i, 'Vol-targeted trend exit long');
                }
            } else if (position === 'short') {
                if (prev <= entry && curr > entry) {
                    position = 'long';
                    return createBuySignal(cleanData, i, 'Vol-targeted trend flip to long');
                }
                if (prev <= -exit && curr > -exit) {
                    position = null;
                    return createBuySignal(cleanData, i, 'Vol-targeted trend exit short');
                }
            } else {
                if (prev <= entry && curr > entry) {
                    position = 'long';
                    return createBuySignal(cleanData, i, 'Vol-targeted trend long entry');
                }
                if (prev >= -entry && curr < -entry) {
                    position = 'short';
                    return createSellSignal(cleanData, i, 'Vol-targeted trend short entry');
                }
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const { fast, slow, scaledTrend } = calculateVolTargetedSeries(cleanData, params);

        return [
            { name: 'Fast EMA', type: 'line', values: fast, color: COLORS.Fast },
            { name: 'Slow EMA', type: 'line', values: slow, color: COLORS.Slow },
            { name: 'Scaled Trend', type: 'histogram', values: scaledTrend, color: COLORS.Histogram }
        ];
    }
};
