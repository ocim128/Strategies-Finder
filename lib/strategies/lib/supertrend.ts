import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { calculateSupertrend } from '../indicators';
import { COLORS } from '../constants';

export const supertrend_strategy: Strategy = {
    name: 'Supertrend Strategy',
    description: 'Buy when Supertrend flips bullish, sell when it flips bearish',
    defaultParams: { period: 10, factor: 3 },
    paramLabels: { period: 'ATR Period', factor: 'Multiplier' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        // Clean data to handle potential undefined/null elements
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const closes = cleanData.map(d => d.close);
        const { direction } = calculateSupertrend(highs, lows, closes, params.period, params.factor);

        return createSignalLoop(cleanData, [direction], (i) => {
            if (direction[i - 1] === -1 && direction[i] === 1) {
                return createBuySignal(data, i, 'Supertrend Buy Flip');
            } else if (direction[i - 1] === 1 && direction[i] === -1) {
                return createSellSignal(data, i, 'Supertrend Sell Flip');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        // Clean data to handle potential undefined/null elements
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const closes = cleanData.map(d => d.close);
        const { supertrend } = calculateSupertrend(highs, lows, closes, params.period, params.factor);
        return [
            { name: 'Supertrend', type: 'line', values: supertrend, color: COLORS.Trend }
        ];
    }
};
