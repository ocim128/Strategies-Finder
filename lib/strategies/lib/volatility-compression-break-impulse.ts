import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';

const LOOKBACK = 1;
const SHORT_ATR_PERIOD = 7;
const LONG_ATR_PERIOD = 28;

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const volatility_compression_break_impulse: Strategy = {
    name: 'Volatility Compression Break Impulse',
    description: 'Breaks previous bar range after compression only when breakout candle body has minimum ATR impulse. Range lookback is fixed at 1 and ATR buffer is fixed at 0.',
    defaultParams: {
        compressionRatio: 0.7,
        minBodyAtr: 0.35,
    },
    paramLabels: {
        compressionRatio: 'ATR Compression Ratio',
        minBodyAtr: 'Min Body Size (ATR)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const compressionRatio = clamp(params.compressionRatio ?? 0.7, 0.1, 1.5);
        const minBodyAtr = clamp(params.minBodyAtr ?? 0.35, 0.05, 3);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atrShort = calculateATR(highs, lows, closes, SHORT_ATR_PERIOD);
        const atrLong = calculateATR(highs, lows, closes, LONG_ATR_PERIOD);
        const { upper, lower } = calculateDonchianChannels(highs, lows, LOOKBACK);

        const signals: Signal[] = [];

        for (let i = 1; i < cleanData.length; i++) {
            const atrSPrev = atrShort[i - 1];
            const atrLPrev = atrLong[i - 1];
            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];

            if (
                atrSPrev === null ||
                atrLPrev === null ||
                prevUpper === null ||
                prevLower === null ||
                atrSPrev <= 0 ||
                atrLPrev <= 0
            ) {
                continue;
            }

            const compressed = atrSPrev <= atrLPrev * compressionRatio;
            if (!compressed) continue;

            const bodyAtr = Math.abs(cleanData[i].close - cleanData[i].open) / atrSPrev;
            if (!Number.isFinite(bodyAtr) || bodyAtr < minBodyAtr) continue;

            const prevClose = closes[i - 1];
            const close = closes[i];
            if (prevClose <= prevUpper && close > prevUpper) {
                signals.push(createBuySignal(cleanData, i, 'VCB Impulse Break Up'));
                continue;
            }

            if (prevClose >= prevLower && close < prevLower) {
                signals.push(createSellSignal(cleanData, i, 'VCB Impulse Break Down'));
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['compressionRatio', 'minBodyAtr'],
    },
};

