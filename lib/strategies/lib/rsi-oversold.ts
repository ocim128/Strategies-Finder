import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateRSI } from '../indicators';
import { COLORS } from '../constants';

export const rsi_oversold: Strategy = {
    name: 'RSI Overbought/Oversold',
    description: 'Buy when RSI rises above oversold level, sell when it falls below overbought',
    defaultParams: { period: 14, oversold: 30, overbought: 70 },
    paramLabels: { period: 'RSI Period', oversold: 'Oversold Level', overbought: 'Overbought Level' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const rsi = calculateRSI(closes, params.period);

        return createSignalLoop(data, [rsi], (i) => {
            // Buy when RSI crosses above oversold
            if (rsi[i - 1]! <= params.oversold && rsi[i]! > params.oversold) {
                return createBuySignal(data, i, `RSI crossed above ${params.oversold}`);
            }
            // Sell when RSI crosses below overbought
            else if (rsi[i - 1]! >= params.overbought && rsi[i]! < params.overbought) {
                return createSellSignal(data, i, `RSI crossed below ${params.overbought}`);
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        return [
            { name: 'RSI', type: 'line', values: calculateRSI(closes, params.period), color: COLORS.Neutral }
        ];
    }
};
