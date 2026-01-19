import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { calculateStochastic } from '../indicators';
import { COLORS } from '../constants';

export const stochastic_crossover: Strategy = {
    name: 'Stochastic Oscillator',
    description: 'Buy when %K crosses above %D in oversold zone, sell when crosses below in overbought',
    defaultParams: { kPeriod: 14, dPeriod: 3, oversold: 20, overbought: 80 },
    paramLabels: { kPeriod: '%K Period', dPeriod: '%D Period', oversold: 'Oversold Level', overbought: 'Overbought Level' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const closes = cleanData.map(d => d.close);
        const { k, d } = calculateStochastic(highs, lows, closes, params.kPeriod, params.dPeriod);

        return createSignalLoop(cleanData, [k, d], (i) => {
            // Buy: %K crosses above %D in oversold zone
            if (k[i - 1]! <= d[i - 1]! && k[i]! > d[i]! && k[i]! < params.oversold + 20) {
                return createBuySignal(cleanData, i, `Stochastic bullish cross (K: ${k[i]!.toFixed(1)})`);
            }
            // Sell: %K crosses below %D in overbought zone
            else if (k[i - 1]! >= d[i - 1]! && k[i]! < d[i]! && k[i]! > params.overbought - 20) {
                return createSellSignal(cleanData, i, `Stochastic bearish cross (K: ${k[i]!.toFixed(1)})`);
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const closes = cleanData.map(d => d.close);
        const { k, d } = calculateStochastic(highs, lows, closes, params.kPeriod, params.dPeriod);
        return [
            { name: '%K', type: 'line', values: k, color: COLORS.Fast },
            { name: '%D', type: 'line', values: d, color: COLORS.Slow }
        ];
    }
};
