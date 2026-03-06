import { OHLCVData, Signal, Strategy, StrategyParams } from '../../types/strategies';
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from '../strategy-helpers';
import { calculateADX } from '../indicators';

export const adx_slope_pivot_entry: Strategy = {
    name: 'ADX Slope Pivot Entry',
    description: 'Uses rising ADX slope to gate momentum and trades closes that break recent pivot ranges.',
    defaultParams: {
        adxPeriod: 14,
        pivotBars: 5,
        adxSlopeLen: 3,
    },
    paramLabels: {
        adxPeriod: 'ADX Period',
        pivotBars: 'Pivot Lookback (bars)',
        adxSlopeLen: 'ADX Slope Length',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 8) return [];

        const adxPeriod = Math.max(2, Math.round(params.adxPeriod ?? 14));
        const pivotBars = Math.max(2, Math.round(params.pivotBars ?? 5));
        const adxSlopeLen = Math.max(1, Math.round(params.adxSlopeLen ?? 3));

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const adx = calculateADX(highs, lows, closes, adxPeriod);

        const signals: Signal[] = [];

        for (let i = Math.max(pivotBars, adxSlopeLen); i < cleanData.length; i++) {
            const adxNow = adx[i];
            const adxPast = adx[i - adxSlopeLen];
            if (adxNow === null || adxPast === null) continue;

            if (adxNow <= adxPast) continue;

            let recentHigh = highs[i - 1];
            let recentLow = lows[i - 1];
            for (let j = i - pivotBars; j < i; j++) {
                recentHigh = Math.max(recentHigh, highs[j]);
                recentLow = Math.min(recentLow, lows[j]);
            }

            const close = closes[i];
            if (close > recentHigh) {
                signals.push(createBuySignal(cleanData, i, 'ADX rising + pivot high break'));
            } else if (close < recentLow) {
                signals.push(createSellSignal(cleanData, i, 'ADX rising + pivot low break'));
            }
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['adxPeriod', 'pivotBars', 'adxSlopeLen'],
    },
};

