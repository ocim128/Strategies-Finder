import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';
import { COLORS } from '../constants';

export const liquidity_sweep_reclaim: Strategy = {
    name: 'Liquidity Sweep Reclaim',
    description: 'Trades failed range breaks when price sweeps liquidity and quickly reclaims the prior range.',
    defaultParams: {
        lookback: 24,
        bufferAtr: 0.12,
        cooldownBars: 4
    },
    paramLabels: {
        lookback: 'Range Lookback',
        bufferAtr: 'Sweep Buffer (ATR)',
        cooldownBars: 'Cooldown (bars)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.round(params.lookback ?? 24));
        const bufferAtr = Math.max(0, params.bufferAtr ?? 0.12);
        const cooldownBars = Math.max(0, Math.round(params.cooldownBars ?? 4));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const atr = calculateATR(highs, lows, closes, 14);

        let lastSignalIndex = -9999;

        return createSignalLoop(cleanData, [upper, lower, atr], (i) => {
            if (i - lastSignalIndex <= cooldownBars) return null;

            const prevUpper = upper[i - 1] as number;
            const prevLower = lower[i - 1] as number;
            const atrValue = atr[i - 1] as number;
            const buffer = atrValue * bufferAtr;

            const high = highs[i];
            const low = lows[i];
            const close = closes[i];

            const sweptHigh = high > prevUpper + buffer;
            const reclaimedInsideHigh = close < prevUpper;
            if (sweptHigh && reclaimedInsideHigh) {
                lastSignalIndex = i;
                return createSellSignal(cleanData, i, 'Sweep High Reclaim');
            }

            const sweptLow = low < prevLower - buffer;
            const reclaimedInsideLow = close > prevLower;
            if (sweptLow && reclaimedInsideLow) {
                lastSignalIndex = i;
                return createBuySignal(cleanData, i, 'Sweep Low Reclaim');
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.round(params.lookback ?? 24));
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const { upper, lower, middle } = calculateDonchianChannels(highs, lows, lookback);

        return [
            { name: 'Range High', type: 'line', values: upper, color: COLORS.Channel },
            { name: 'Range Mid', type: 'line', values: middle, color: COLORS.Neutral },
            { name: 'Range Low', type: 'line', values: lower, color: COLORS.Channel }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['lookback', 'bufferAtr', 'cooldownBars']
    }
};
