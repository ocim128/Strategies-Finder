import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateEMA } from '../indicators';
import { COLORS } from '../constants';

export const triple_ma: Strategy = {
    name: 'Triple MA Strategy',
    description: 'Uses 3 MAs: buy when all aligned bullish, sell when all aligned bearish',
    defaultParams: { fastPeriod: 5, mediumPeriod: 20, slowPeriod: 50 },
    paramLabels: { fastPeriod: 'Fast Period', mediumPeriod: 'Medium Period', slowPeriod: 'Slow Period' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const fast = calculateEMA(closes, params.fastPeriod);
        const medium = calculateEMA(closes, params.mediumPeriod);
        const slow = calculateEMA(closes, params.slowPeriod);

        let inPosition = false;

        return createSignalLoop(data, [fast, medium, slow], (i) => {
            const bullish = fast[i]! > medium[i]! && medium[i]! > slow[i]!;
            const bearish = fast[i]! < medium[i]! && medium[i]! < slow[i]!;

            if (bullish && !inPosition) {
                inPosition = true;
                return createBuySignal(data, i, 'Triple MA Bullish Alignment');
            }
            else if (bearish && inPosition) {
                inPosition = false;
                return createSellSignal(data, i, 'Triple MA Bearish Alignment');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        return [
            { name: 'Fast EMA', type: 'line', values: calculateEMA(closes, params.fastPeriod), color: COLORS.Fast },
            { name: 'Medium EMA', type: 'line', values: calculateEMA(closes, params.mediumPeriod), color: COLORS.Slow },
            { name: 'Slow EMA', type: 'line', values: calculateEMA(closes, params.slowPeriod), color: COLORS.Positive }
        ];
    }
};
