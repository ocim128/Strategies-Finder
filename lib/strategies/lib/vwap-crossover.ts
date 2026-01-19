import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateVWAP, calculateEMA } from '../indicators';
import { COLORS } from '../constants';

export const vwap_crossover: Strategy = {
    name: 'VWAP Crossover',
    description: 'Buy when price crosses above VWAP, sell when crosses below. Uses EMA for smoothing.',
    defaultParams: { emaPeriod: 9 },
    paramLabels: { emaPeriod: 'EMA Smoothing Period' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const vwap = calculateVWAP(data);
        const closes = data.map(d => d.close);
        const priceEMA = calculateEMA(closes, params.emaPeriod);

        return createSignalLoop(data, [vwap, priceEMA], (i) => {
            // Buy: Price EMA crosses above VWAP
            if (priceEMA[i - 1]! <= vwap[i - 1]! && priceEMA[i]! > vwap[i]!) {
                return createBuySignal(data, i, 'Price crossed above VWAP');
            }
            // Sell: Price EMA crosses below VWAP
            else if (priceEMA[i - 1]! >= vwap[i - 1]! && priceEMA[i]! < vwap[i]!) {
                return createSellSignal(data, i, 'Price crossed below VWAP');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], _params: StrategyParams): StrategyIndicator[] => {
        return [
            { name: 'VWAP', type: 'line', values: calculateVWAP(data), color: COLORS.VWAP }
        ];
    }
};
