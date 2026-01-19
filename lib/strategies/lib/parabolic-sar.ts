import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { calculateParabolicSAR } from '../indicators';
import { COLORS } from '../constants';

export const parabolic_sar: Strategy = {
    name: 'Parabolic SAR',
    description: 'Buy when price crosses above SAR, sell when it crosses below',
    defaultParams: { start: 0.02, increment: 0.02, max: 0.2 },
    paramLabels: { start: 'Start AF', increment: 'Increment', max: 'Max AF' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const closes = cleanData.map(d => d.close);
        const sar = calculateParabolicSAR(highs, lows, params.start, params.increment, params.max);

        return createSignalLoop(cleanData, [sar], (i) => {
            if (closes[i - 1] <= sar[i - 1]! && closes[i] > sar[i]!) {
                return createBuySignal(cleanData, i, 'Price crossed above PSAR');
            } else if (closes[i - 1] >= sar[i - 1]! && closes[i] < sar[i]!) {
                return createSellSignal(cleanData, i, 'Price crossed below PSAR');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        return [
            { name: 'Parabolic SAR', type: 'line', values: calculateParabolicSAR(highs, lows, params.start, params.increment, params.max), color: COLORS.PSAR }
        ];
    }
};
