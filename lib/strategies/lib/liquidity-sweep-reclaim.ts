import { Strategy, OHLCVData, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels, calculateEMA } from '../indicators';

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

        // Oxygen sweep bounds: constrain search to the requested range.
        const lookback = Math.max(12, Math.min(48, Math.round(params.lookback ?? 24)));
        const bufferAtr = Math.max(0.05, Math.min(0.25, params.bufferAtr ?? 0.12));
        const cooldownBars = Math.max(0, Math.round(params.cooldownBars ?? 4));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const atr = calculateATR(highs, lows, closes, 14);
        const trendEma = calculateEMA(closes, 200);

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
            const ema200 = trendEma[i - 1];
            if (ema200 === null || ema200 === undefined) return null;
            const longTrendOk = close > ema200;
            const shortTrendOk = close < ema200;

            const sweptHigh = high > prevUpper + buffer;
            const reclaimedInsideHigh = close < prevUpper;
            if (sweptHigh && reclaimedInsideHigh && shortTrendOk) {
                lastSignalIndex = i;
                return createSellSignal(cleanData, i, 'Sweep High Reclaim');
            }

            const sweptLow = low < prevLower - buffer;
            const reclaimedInsideLow = close > prevLower;
            if (sweptLow && reclaimedInsideLow && longTrendOk) {
                lastSignalIndex = i;
                return createBuySignal(cleanData, i, 'Sweep Low Reclaim');
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['lookback', 'bufferAtr', 'cooldownBars']
    }
};


