import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { COLORS } from '../constants';

function calculateZScore(series: number[], period: number): {
    z: (number | null)[];
    mean: (number | null)[];
    stdev: (number | null)[];
} {
    const z: (number | null)[] = new Array(series.length).fill(null);
    const mean: (number | null)[] = new Array(series.length).fill(null);
    const stdev: (number | null)[] = new Array(series.length).fill(null);

    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < series.length; i++) {
        const value = series[i];
        sum += value;
        sumSq += value * value;

        if (i >= period) {
            const oldValue = series[i - period];
            sum -= oldValue;
            sumSq -= oldValue * oldValue;
        }

        if (i >= period - 1) {
            const avg = sum / period;
            const variance = Math.max(0, sumSq / period - avg * avg);
            const sd = Math.sqrt(variance);
            mean[i] = avg;
            stdev[i] = sd;
            z[i] = sd === 0 ? 0 : (value - avg) / sd;
        }
    }

    return { z, mean, stdev };
}

export const mean_reversion_zscore: Strategy = {
    name: 'Mean Reversion Z-Score',
    description: 'Reverts to mean using Z-score thresholds with simple entry/exit bands.',
    defaultParams: {
        lookback: 50,
        zEntry: 2.0,
        zExit: 0.5
    },
    paramLabels: {
        lookback: 'Z Lookback',
        zEntry: 'Z Entry',
        zExit: 'Z Exit'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 50));
        const zEntry = Math.max(0.1, params.zEntry ?? 2.0);
        const zExit = Math.max(0, params.zExit ?? 0.5);

        const closes = getCloses(cleanData);
        const { z } = calculateZScore(closes, lookback);

        let position: 'long' | 'short' | null = null;

        return createSignalLoop(cleanData, [z], (i) => {
            const zPrev = z[i - 1] as number;
            const zCurr = z[i] as number;

            if (position === null) {
                if (zPrev > -zEntry && zCurr <= -zEntry) {
                    position = 'long';
                    return createBuySignal(cleanData, i, 'Z-Score Long Entry');
                }
                if (zPrev < zEntry && zCurr >= zEntry) {
                    position = 'short';
                    return createSellSignal(cleanData, i, 'Z-Score Short Entry');
                }
            } else if (position === 'long') {
                if (zPrev < -zExit && zCurr >= -zExit) {
                    position = null;
                    return createSellSignal(cleanData, i, 'Z-Score Long Exit');
                }
            } else if (position === 'short') {
                if (zPrev > zExit && zCurr <= zExit) {
                    position = null;
                    return createBuySignal(cleanData, i, 'Z-Score Short Exit');
                }
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 50));
        const closes = getCloses(cleanData);
        const { z } = calculateZScore(closes, lookback);

        return [
            { name: 'Z-Score', type: 'line', values: z, color: COLORS.Neutral }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both'
    }
};
