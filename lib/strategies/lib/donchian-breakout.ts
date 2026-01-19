import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { calculateDonchianChannels } from '../indicators';
import { COLORS } from '../constants';

export const donchian_breakout: Strategy = {
    name: 'Donchian Breakout',
    description: 'Buy when price breaks above the upper Donchian Channel, sell when it breaks below the lower channel',
    defaultParams: { period: 20 },
    paramLabels: { period: 'Channel Period' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const { upper, lower } = calculateDonchianChannels(highs, lows, params.period);

        let inPosition = false;

        return createSignalLoop(cleanData, [upper, lower], (i) => {
            // Breakout buy: Price crosses above the *previous* high
            const prevUpper = upper[i - 1]!;
            const prevLower = lower[i - 1]!;

            if (!inPosition && cleanData[i].close > prevUpper) {
                inPosition = true;
                return createBuySignal(cleanData, i, 'Donchian Upside Breakout');
            } else if (inPosition && cleanData[i].close < prevLower) {
                inPosition = false;
                return createSellSignal(cleanData, i, 'Donchian Downside Breakout');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const highs = cleanData.map(d => d.high);
        const lows = cleanData.map(d => d.low);
        const { upper, middle, lower } = calculateDonchianChannels(highs, lows, params.period);
        return [
            { name: 'DC Upper', type: 'line', values: upper, color: COLORS.Channel },
            { name: 'DC Middle', type: 'line', values: middle, color: COLORS.Channel },
            { name: 'DC Lower', type: 'line', values: lower, color: COLORS.Channel }
        ];
    }
};
