import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';

export const rubber_band_reversion: Strategy = {
    name: 'Rubber Band Reversion',
    description: 'Fades extreme ATR-normalized stretches away from the EMA mean and exits on mean reversion or ATR stop.',
    defaultParams: {
        meanPeriod: 50,
        stretchFactor: 2.5,
        stopLossATR: 2.0
    },
    paramLabels: {
        meanPeriod: 'Mean EMA Period',
        stretchFactor: 'Stretch Factor (ATR)',
        stopLossATR: 'Stop Loss (ATR)'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const meanPeriod = Math.max(5, Math.round(params.meanPeriod ?? 50));
        const stretchFactor = Math.max(0.1, params.stretchFactor ?? 2.5);
        const stopLossATR = Math.max(0.1, params.stopLossATR ?? 2.0);

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const mean = calculateEMA(closes, meanPeriod);
        const atr = calculateATR(highs, lows, closes, 14);

        const signals: Signal[] = [];
        let position: 'flat' | 'long' | 'short' = 'flat';
        let stopPrice = 0;
        let entryIndex = -1;

        for (let i = 1; i < cleanData.length; i++) {
            const meanNow = mean[i];
            const atrNow = atr[i];
            if (meanNow === null || atrNow === null || atrNow <= 0) continue;

            const close = closes[i];

            if (position === 'long') {
                const stopHit = i > entryIndex && lows[i] <= stopPrice;
                const meanExit = close >= meanNow;
                if (stopHit || meanExit) {
                    signals.push(createSellSignal(
                        cleanData,
                        i,
                        stopHit ? 'Rubber Band long stop' : 'Rubber Band long mean exit'
                    ));
                    position = 'flat';
                    stopPrice = 0;
                    entryIndex = -1;
                }
                continue;
            }

            if (position === 'short') {
                const stopHit = i > entryIndex && highs[i] >= stopPrice;
                const meanExit = close <= meanNow;
                if (stopHit || meanExit) {
                    signals.push(createBuySignal(
                        cleanData,
                        i,
                        stopHit ? 'Rubber Band short stop' : 'Rubber Band short mean exit'
                    ));
                    position = 'flat';
                    stopPrice = 0;
                    entryIndex = -1;
                }
                continue;
            }

            const threshold = stretchFactor * atrNow;
            if (close <= meanNow - threshold) {
                signals.push(createBuySignal(cleanData, i, 'Rubber Band long entry'));
                position = 'long';
                stopPrice = close - (stopLossATR * atrNow);
                entryIndex = i;
            } else if (close >= meanNow + threshold) {
                signals.push(createSellSignal(cleanData, i, 'Rubber Band short entry'));
                position = 'short';
                stopPrice = close + (stopLossATR * atrNow);
                entryIndex = i;
            }
        }

        if (position === 'long' && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'Rubber Band final close'));
        } else if (position === 'short' && cleanData.length > 0) {
            signals.push(createBuySignal(cleanData, cleanData.length - 1, 'Rubber Band final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['meanPeriod', 'stretchFactor', 'stopLossATR']
    }
};
