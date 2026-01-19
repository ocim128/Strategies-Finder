import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateMomentum } from '../indicators';
import { COLORS } from '../constants';

export const momentum_strategy: Strategy = {
    name: 'Momentum Strategy',
    description: 'Buy when momentum is positive, sell when negative',
    defaultParams: { period: 10, threshold: 0 },
    paramLabels: { period: 'Lookback Period', threshold: 'Signal Threshold' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const mom = calculateMomentum(closes, params.period);

        return createSignalLoop(data, [mom], (i) => {
            if (mom[i - 1]! <= params.threshold && mom[i]! > params.threshold) {
                return createBuySignal(data, i, 'Positive Momentum Cross');
            } else if (mom[i - 1]! >= params.threshold && mom[i]! < params.threshold) {
                return createSellSignal(data, i, 'Negative Momentum Cross');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        return [
            { name: 'Momentum', type: 'line', values: calculateMomentum(closes, params.period), color: COLORS.Positive }
        ];
    }
};
