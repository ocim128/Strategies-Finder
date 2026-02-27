import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels, calculateSMA } from '../indicators';

const LOOKBACK = 1;
const SHORT_ATR_PERIOD = 7;
const LONG_ATR_PERIOD = 28;
const VOLUME_SMA_PERIOD = 20;

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const volatility_compression_break_volume: Strategy = {
    name: 'Volatility Compression Break Volume',
    description: 'Breaks previous bar range after compression only when breakout volume exceeds a prior volume baseline. Range lookback is fixed at 1 and ATR buffer is fixed at 0.',
    defaultParams: {
        compressionRatio: 0.7,
        volumeMult: 1.5,
    },
    paramLabels: {
        compressionRatio: 'ATR Compression Ratio',
        volumeMult: 'Volume Multiplier',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const compressionRatio = clamp(params.compressionRatio ?? 0.7, 0.1, 1.5);
        const volumeMult = clamp(params.volumeMult ?? 1.5, 0.5, 5);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const atrShort = calculateATR(highs, lows, closes, SHORT_ATR_PERIOD);
        const atrLong = calculateATR(highs, lows, closes, LONG_ATR_PERIOD);
        const volumeSma = calculateSMA(volumes, VOLUME_SMA_PERIOD);
        const { upper, lower } = calculateDonchianChannels(highs, lows, LOOKBACK);

        const signals: Signal[] = [];

        for (let i = 1; i < cleanData.length; i++) {
            const atrSPrev = atrShort[i - 1];
            const atrLPrev = atrLong[i - 1];
            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];
            const volBase = volumeSma[i - 1];

            if (
                atrSPrev === null ||
                atrLPrev === null ||
                prevUpper === null ||
                prevLower === null ||
                volBase === null ||
                atrSPrev <= 0 ||
                atrLPrev <= 0 ||
                volBase <= 0
            ) {
                continue;
            }

            const compressed = atrSPrev <= atrLPrev * compressionRatio;
            if (!compressed) continue;

            const volumeOk = volumes[i] >= volBase * volumeMult;
            if (!volumeOk) continue;

            const prevClose = closes[i - 1];
            const close = closes[i];
            if (prevClose <= prevUpper && close > prevUpper) {
                signals.push(createBuySignal(cleanData, i, 'VCB Volume Break Up'));
                continue;
            }

            if (prevClose >= prevLower && close < prevLower) {
                signals.push(createSellSignal(cleanData, i, 'VCB Volume Break Down'));
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['compressionRatio', 'volumeMult'],
    },
};

