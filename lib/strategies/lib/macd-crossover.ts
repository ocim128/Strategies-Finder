import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, checkCrossover, createSignalLoop, getCloses } from '../strategy-helpers';
import { calculateMACD } from '../indicators';
import { COLORS } from '../constants';

export const macd_crossover: Strategy = {
    name: 'MACD Crossover',
    description: 'Standard MACD crossover strategy',
    defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    paramLabels: { fastPeriod: 'Fast EMA', slowPeriod: 'Slow EMA', signalPeriod: 'Signal EMA' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = getCloses(data);
        const { macd, signal } = calculateMACD(closes, params.fastPeriod, params.slowPeriod, params.signalPeriod);

        return createSignalLoop(data, [macd, signal], (i) => {
            const crossover = checkCrossover(macd, signal, i);
            if (crossover === 'bullish') {
                return createBuySignal(data, i, 'MACD Bullish Cross');
            } else if (crossover === 'bearish') {
                return createSellSignal(data, i, 'MACD Bearish Cross');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = getCloses(data);

        const { macd, signal, histogram } = calculateMACD(closes, params.fastPeriod, params.slowPeriod, params.signalPeriod);
        return [
            { name: 'MACD', type: 'line', values: macd, color: COLORS.Fast },
            { name: 'Signal', type: 'line', values: signal, color: COLORS.Slow },
            { name: 'Histogram', type: 'histogram', values: histogram, color: COLORS.Histogram }
        ];
    }
};
