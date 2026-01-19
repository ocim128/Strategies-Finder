import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, checkCrossover, createSignalLoop } from '../strategy-helpers';
import { calculateEMA } from '../indicators';
import { COLORS } from '../constants';

export const ema_crossover: Strategy = {
    name: 'EMA Crossover',
    description: 'Buy when fast EMA crosses above slow EMA, sell when it crosses below',
    defaultParams: { fastPeriod: 12, slowPeriod: 26 },
    paramLabels: { fastPeriod: 'Fast Period', slowPeriod: 'Slow Period' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const fastEMA = calculateEMA(closes, params.fastPeriod);
        const slowEMA = calculateEMA(closes, params.slowPeriod);

        return createSignalLoop(data, [fastEMA, slowEMA], (i) => {
            const crossover = checkCrossover(fastEMA, slowEMA, i);
            if (crossover === 'bullish') {
                return createBuySignal(data, i, 'EMA Bullish Cross');
            } else if (crossover === 'bearish') {
                return createSellSignal(data, i, 'EMA Bearish Cross');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        return [
            { name: 'Fast EMA', type: 'line', values: calculateEMA(closes, params.fastPeriod), color: COLORS.Fast },
            { name: 'Slow EMA', type: 'line', values: calculateEMA(closes, params.slowPeriod), color: COLORS.Slow }
        ];
    }
};
