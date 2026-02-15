import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';

function clampInt(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.max(min, Math.min(max, rounded));
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const volatility_compression_trigger: Strategy = {
    name: 'Volatility Compression Trigger',
    description: 'Arms after ATR compression versus recent peak volatility, then enters on directional range expansion.',
    defaultParams: {
        atrPeriod: 14,
        compressionLookback: 20,
        compressionRatio: 0.45,
        breakoutLookback: 20,
        breakoutBufferAtr: 0.05,
        armedBars: 6,
        cooldownBars: 3,
    },
    paramLabels: {
        atrPeriod: 'ATR Period',
        compressionLookback: 'Compression Lookback',
        compressionRatio: 'Compression Ratio',
        breakoutLookback: 'Breakout Lookback',
        breakoutBufferAtr: 'Breakout Buffer (ATR)',
        armedBars: 'Armed Bars',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const atrPeriod = clampInt(params.atrPeriod ?? 14, 2, 100);
        const compressionLookback = clampInt(params.compressionLookback ?? 20, 5, 250);
        const compressionRatio = clamp(params.compressionRatio ?? 0.45, 0.05, 1);
        const breakoutLookback = clampInt(params.breakoutLookback ?? 20, 3, 250);
        const breakoutBufferAtr = clamp(params.breakoutBufferAtr ?? 0.05, 0, 1);
        const armedBars = clampInt(params.armedBars ?? 6, 1, 100);
        const cooldownBars = clampInt(params.cooldownBars ?? 3, 0, 200);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, atrPeriod);
        const { upper, lower } = calculateDonchianChannels(highs, lows, breakoutLookback);

        const signals: Signal[] = [];
        let armedUntil = -1;
        let lastSignalIndex = -10_000;

        for (let i = 1; i < cleanData.length; i++) {
            if (i >= compressionLookback - 1) {
                const currentAtr = atr[i];
                if (currentAtr !== null && currentAtr > 0) {
                    let windowMaxAtr = 0;
                    const start = i - compressionLookback + 1;
                    for (let j = start; j <= i; j++) {
                        const value = atr[j];
                        if (value !== null && value > windowMaxAtr) {
                            windowMaxAtr = value;
                        }
                    }

                    if (windowMaxAtr > 0 && currentAtr <= windowMaxAtr * compressionRatio) {
                        armedUntil = Math.max(armedUntil, i + armedBars);
                    }
                }
            }

            if (i - lastSignalIndex <= cooldownBars) continue;
            if (i > armedUntil) continue;

            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];
            const atrRef = atr[i - 1];
            if (prevUpper === null || prevLower === null || atrRef === null || atrRef <= 0) continue;

            const buffer = atrRef * breakoutBufferAtr;
            const prevClose = closes[i - 1];
            const close = closes[i];

            if (prevClose <= prevUpper + buffer && close > prevUpper + buffer) {
                signals.push(createBuySignal(cleanData, i, 'VCT Breakout Up'));
                lastSignalIndex = i;
                armedUntil = -1;
                continue;
            }

            if (prevClose >= prevLower - buffer && close < prevLower - buffer) {
                signals.push(createSellSignal(cleanData, i, 'VCT Breakout Down'));
                lastSignalIndex = i;
                armedUntil = -1;
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'atrPeriod',
            'compressionLookback',
            'compressionRatio',
            'breakoutLookback',
            'breakoutBufferAtr',
            'armedBars',
            'cooldownBars',
        ],
    },
};

