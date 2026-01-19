import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateBollingerBands } from '../indicators';
import { COLORS } from '../constants';

export const bollinger_bounce: Strategy = {
    name: 'Bollinger Band Bounce',
    description: 'Buy when price bounces off lower band, sell when it bounces off upper band',
    defaultParams: { period: 20, stdDev: 2 },
    paramLabels: { period: 'Period', stdDev: 'Std Deviations' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const { upper, lower } = calculateBollingerBands(closes, params.period, params.stdDev);

        return createSignalLoop(data, [upper, lower], (i) => {
            // Buy: price touched lower band and now bouncing up
            if (data[i - 1].low <= lower[i - 1]! && data[i].close > data[i - 1].close) {
                return createBuySignal(data, i, 'Lower BB Bounce');
            }
            // Sell: price touched upper band and now bouncing down
            else if (data[i - 1].high >= upper[i - 1]! && data[i].close < data[i - 1].close) {
                return createSellSignal(data, i, 'Upper BB Bounce');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        const { upper, middle, lower } = calculateBollingerBands(closes, params.period, params.stdDev);
        return [
            { name: 'BB Upper', type: 'line', values: upper, color: COLORS.Neutral },
            { name: 'BB Middle', type: 'line', values: middle, color: COLORS.Neutral },
            { name: 'BB Lower', type: 'line', values: lower, color: COLORS.Neutral }
        ];
    }
};
