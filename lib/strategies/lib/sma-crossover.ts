import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, checkCrossover, createSignalLoop } from '../strategy-helpers';
import { calculateSMA } from '../indicators';
import { COLORS } from '../constants';

export const sma_crossover: Strategy = {
    name: 'SMA Crossover',
    description: 'Buy when fast SMA crosses above slow SMA, sell when it crosses below',
    defaultParams: { fastPeriod: 10, slowPeriod: 30 },
    paramLabels: { fastPeriod: 'Fast Period', slowPeriod: 'Slow Period' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const fastSMA = calculateSMA(closes, params.fastPeriod);
        const slowSMA = calculateSMA(closes, params.slowPeriod);

        return createSignalLoop(data, [fastSMA, slowSMA], (i) => {
            const crossover = checkCrossover(fastSMA, slowSMA, i);
            if (crossover === 'bullish') {
                return createBuySignal(data, i, 'SMA Golden Cross');
            } else if (crossover === 'bearish') {
                return createSellSignal(data, i, 'SMA Death Cross');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        return [
            { name: 'Fast SMA', type: 'line', values: calculateSMA(closes, params.fastPeriod), color: COLORS.Fast },
            { name: 'Slow SMA', type: 'line', values: calculateSMA(closes, params.slowPeriod), color: COLORS.Slow }
        ];
    }
};
