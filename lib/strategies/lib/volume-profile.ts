import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop } from '../strategy-helpers';
import { calculateVolumeProfile } from '../indicators';
import { COLORS } from '../constants';

export const volume_profile: Strategy = {
    name: 'Volume Profile Reversion',
    description: 'Trade reversions from Value Area High/Low back to Point of Control (POC)',
    defaultParams: { period: 200, bins: 24 },
    paramLabels: { period: 'Profile Lookback', bins: 'Price Bins' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const { poc, vah, val } = calculateVolumeProfile(data, params.period, params.bins);

        return createSignalLoop(data, [poc, vah, val], (i) => {
            const close = data[i].close;
            const prevClose = data[i - 1].close;

            // Buy: Price dips below VAL and returns up inside VA
            if (prevClose < val[i]! && close > val[i]!) {
                return createBuySignal(data, i, 'Re-entry into Value Area (Low)');
            }
            // Sell: Price peaks above VAH and returns down inside VA
            else if (prevClose > vah[i]! && close < vah[i]!) {
                return createSellSignal(data, i, 'Re-entry into Value Area (High)');
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const { poc, vah, val } = calculateVolumeProfile(data, params.period, params.bins);
        return [
            { name: 'POC', type: 'line', values: poc, color: COLORS.Histogram },
            { name: 'VAH', type: 'line', values: vah, color: COLORS.Area },
            { name: 'VAL', type: 'line', values: val, color: COLORS.Area }
        ];
    }
};
