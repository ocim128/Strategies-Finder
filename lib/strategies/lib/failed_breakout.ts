import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateATR, calculateDonchianChannels } from '../indicators';
import { COLORS } from '../constants';

export const failed_breakout: Strategy = {
    name: 'Failed Breakout',
    description: 'Fades breakouts that quickly revert back into a recent range.',
    defaultParams: {
        lookback: 40,
        revertBars: 6,
        bufferAtr: 0.2,
        useRevertWindow: 1,
        maxHoldBars: 12,
        maxExtensionAtr: 2.5
    },
    paramLabels: {
        lookback: 'Range Lookback',
        revertBars: 'Revert Window (bars)',
        bufferAtr: 'Breakout Buffer (ATR)',
        useRevertWindow: 'Use Revert Window (0/1)',
        maxHoldBars: 'Max Hold (bars)',
        maxExtensionAtr: 'Max Extension (ATR)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 40));
        const revertBars = Math.max(1, Math.round(params.revertBars ?? 6));
        const bufferAtr = Math.max(0, params.bufferAtr ?? 0.2);
        const useRevertWindow = params.useRevertWindow === undefined ? true : params.useRevertWindow !== 0;
        const maxHoldBars = Math.max(0, Math.round(params.maxHoldBars ?? 12));
        const maxExtensionAtr = Math.max(0, params.maxExtensionAtr ?? 2.5);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const atrPeriod = Math.max(2, Math.min(lookback, 20));
        const atr = calculateATR(highs, lows, closes, atrPeriod);

        type BreakoutState = {
            dir: 'up' | 'down';
            startIndex: number;
            level: number;
        } | null;

        let breakout: BreakoutState = null;

        return createSignalLoop(cleanData, [upper, lower], (i) => {
            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];
            if (prevUpper === null || prevLower === null) return null;

            const atrVal = atr[i - 1] ?? 0;
            const buffer = atrVal * bufferAtr;

            const closePrev = closes[i - 1];
            const closeCurr = closes[i];
            const highCurr = highs[i];
            const lowCurr = lows[i];
            const prevInsideRange = closePrev <= prevUpper && closePrev >= prevLower;

            // Expire breakout window
            if (useRevertWindow && breakout && i - breakout.startIndex > revertBars) {
                breakout = null;
            }

            // Cancel stale breakouts even if window is disabled
            if (breakout && maxHoldBars > 0 && i - breakout.startIndex > maxHoldBars) {
                breakout = null;
            }

            // Cancel breakouts that extend too far (likely real trend)
            if (breakout && maxExtensionAtr > 0) {
                const extension = maxExtensionAtr * atrVal;
                if (breakout.dir === 'up' && highCurr > breakout.level + extension) {
                    breakout = null;
                } else if (breakout.dir === 'down' && lowCurr < breakout.level - extension) {
                    breakout = null;
                }
            }

            // Detect breakout if none active
            if (!breakout) {
                if (prevInsideRange && highCurr > prevUpper + buffer) {
                    breakout = { dir: 'up', startIndex: i, level: prevUpper };
                } else if (prevInsideRange && lowCurr < prevLower - buffer) {
                    breakout = { dir: 'down', startIndex: i, level: prevLower };
                }
                return null;
            }

            // Failed breakout triggers
            if (breakout.dir === 'up') {
                if (closeCurr <= breakout.level) {
                    breakout = null;
                    return createSellSignal(cleanData, i, 'Failed Breakout Short');
                }
            } else if (breakout.dir === 'down') {
                if (closeCurr >= breakout.level) {
                    breakout = null;
                    return createBuySignal(cleanData, i, 'Failed Breakout Long');
                }
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(2, Math.round(params.lookback ?? 40));
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const { upper, lower, middle } = calculateDonchianChannels(highs, lows, lookback);

        return [
            { name: 'Range High', type: 'line', values: upper, color: COLORS.Channel },
            { name: 'Range Low', type: 'line', values: lower, color: COLORS.Channel },
            { name: 'Range Mid', type: 'line', values: middle, color: COLORS.Neutral }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['lookback', 'revertBars', 'bufferAtr', 'useRevertWindow', 'maxHoldBars']
    }
};


