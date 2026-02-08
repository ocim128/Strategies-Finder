import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';
import { COLORS } from '../constants';

export const volatility_compression_break: Strategy = {
    name: 'Volatility Compression Break',
    description: 'Looks for breakouts that begin after short-term volatility compresses versus longer-term volatility.',
    defaultParams: {
        lookback: 20,
        compressionRatio: 0.7,
        breakoutBufferAtr: 0.08
    },
    paramLabels: {
        lookback: 'Range Lookback',
        compressionRatio: 'ATR Compression Ratio',
        breakoutBufferAtr: 'Breakout Buffer (ATR)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.round(params.lookback ?? 20));
        const compressionRatio = Math.max(0.1, params.compressionRatio ?? 0.7);
        const breakoutBufferAtr = Math.max(0, params.breakoutBufferAtr ?? 0.08);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const shortAtr = calculateATR(highs, lows, closes, 7);
        const longAtr = calculateATR(highs, lows, closes, 28);

        return createSignalLoop(cleanData, [upper, lower, shortAtr, longAtr], (i) => {
            const prevUpper = upper[i - 1] as number;
            const prevLower = lower[i - 1] as number;
            const atrShort = shortAtr[i - 1] as number;
            const atrLong = longAtr[i - 1] as number;

            if (atrLong <= 0) return null;
            const compressed = atrShort <= atrLong * compressionRatio;
            if (!compressed) return null;

            const buffer = atrShort * breakoutBufferAtr;
            const prevClose = closes[i - 1];
            const close = closes[i];

            if (prevClose <= prevUpper + buffer && close > prevUpper + buffer) {
                return createBuySignal(cleanData, i, 'Compression Break Up');
            }

            if (prevClose >= prevLower - buffer && close < prevLower - buffer) {
                return createSellSignal(cleanData, i, 'Compression Break Down');
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.round(params.lookback ?? 20));
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const shortAtr = calculateATR(highs, lows, closes, 7);
        const longAtr = calculateATR(highs, lows, closes, 28);

        const ratio: (number | null)[] = shortAtr.map((value, i) => {
            const base = longAtr[i];
            if (value === null || base === null || base <= 0) return null;
            return value / base;
        });

        return [
            { name: 'Range High', type: 'line', values: upper, color: COLORS.Channel },
            { name: 'Range Low', type: 'line', values: lower, color: COLORS.Channel },
            { name: 'ATR Compression Ratio', type: 'line', values: ratio, color: COLORS.Neutral }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['lookback', 'compressionRatio', 'breakoutBufferAtr']
    }
};
