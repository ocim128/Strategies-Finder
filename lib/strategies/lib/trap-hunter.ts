import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';
import { calculateADX, calculateATR, calculateDonchianChannels } from '../indicators';
import { COLORS } from '../constants';

interface TrapHunterState {
    position: 'none' | 'long' | 'short';
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
}



export const trap_hunter: Strategy = {
    name: 'Trap Hunter',
    description: 'Fades failed breakouts using Donchian sweeps with ADX regime filtering',
    defaultParams: {
        lookback: 20,
        adxPeriod: 14,
        adxThreshold: 30,
        stopAtrMult: 1.0,
        riskReward: 2.0,
        minVol: 0.5,
    },
    paramLabels: {
        lookback: 'Donchian Lookback',
        adxPeriod: 'ADX Period',
        adxThreshold: 'ADX Max Trend',
        stopAtrMult: 'Stop ATR Buffer',
        riskReward: 'ATR Target Mult',
        minVol: 'Min Bar Vol (ATR)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.floor(params.lookback));
        const adxPeriod = Math.max(2, Math.floor(params.adxPeriod));
        const adxThreshold = Math.max(5, params.adxThreshold ?? 30);
        const stopAtrMult = Math.max(0, params.stopAtrMult ?? 1.0);
        const riskReward = Math.max(0.1, params.riskReward ?? 2.0);
        const minVol = Math.max(0, params.minVol ?? 0.5);

        const minBars = Math.max(lookback, adxPeriod * 2) + 2;
        if (cleanData.length < minBars) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { upper, lower } = calculateDonchianChannels(highs, lows, lookback);
        const adx = calculateADX(highs, lows, closes, adxPeriod);
        const atr = calculateATR(highs, lows, closes, adxPeriod);

        const signals: Signal[] = [];
        const state: TrapHunterState = {
            position: 'none',
            entryPrice: 0,
            stopPrice: 0,
            targetPrice: 0,
        };

        const startIndex = Math.max(lookback, adxPeriod * 2) + 1;

        for (let i = startIndex; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const prevUpper = upper[i - 1];
            const prevLower = lower[i - 1];
            const adxVal = adx[i];
            const atrVal = atr[i];

            if (prevUpper === null || prevLower === null || adxVal === null || atrVal === null) continue;
            if (!Number.isFinite(atrVal) || atrVal <= 0) continue;

            if (state.position === 'none') {
                if (adxVal >= adxThreshold) continue;

                // Stop Hunt Filter: Bar range must be significant relative to ATR
                const barRange = bar.high - bar.low;
                const isVolatile = barRange >= atrVal * minVol;

                const sweptLow = bar.low < prevLower;
                const rejectedLow = bar.close > prevLower;
                const green = bar.close > bar.open;

                const sweptHigh = bar.high > prevUpper;
                const rejectedHigh = bar.close < prevUpper;
                const red = bar.close < bar.open;

                if (sweptLow && rejectedLow && green && isVolatile) {
                    state.position = 'long';
                    state.entryPrice = bar.close;
                    state.stopPrice = bar.low - atrVal * stopAtrMult;
                    state.targetPrice = bar.close + atrVal * riskReward;

                    signals.push(createBuySignal(cleanData, i, 'Trap Hunter long entry'));
                    continue;
                }

                if (sweptHigh && rejectedHigh && red && isVolatile) {
                    state.position = 'short';
                    state.entryPrice = bar.close;
                    state.stopPrice = bar.high + atrVal * stopAtrMult;
                    state.targetPrice = bar.close - atrVal * riskReward;

                    signals.push(createSellSignal(cleanData, i, 'Trap Hunter short entry'));
                    continue;
                }

                continue;
            }

            if (state.position === 'long') {
                const hitStop = bar.low <= state.stopPrice;
                const hitTarget = bar.high >= state.targetPrice;

                if (hitStop || hitTarget) {
                    signals.push(createSellSignal(cleanData, i, hitStop ? 'Trap Hunter stop loss' : 'Trap Hunter take profit'));
                    state.position = 'none';
                    state.entryPrice = 0;
                    state.stopPrice = 0;
                    state.targetPrice = 0;
                }
            } else if (state.position === 'short') {
                const hitStop = bar.high >= state.stopPrice;
                const hitTarget = bar.low <= state.targetPrice;

                if (hitStop || hitTarget) {
                    signals.push(createBuySignal(cleanData, i, hitStop ? 'Trap Hunter stop loss' : 'Trap Hunter take profit'));
                    state.position = 'none';
                    state.entryPrice = 0;
                    state.stopPrice = 0;
                    state.targetPrice = 0;
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const lookback = Math.max(5, Math.floor(params.lookback));
        const adxPeriod = Math.max(2, Math.floor(params.adxPeriod));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { upper, lower, middle } = calculateDonchianChannels(highs, lows, lookback);
        const adx = calculateADX(highs, lows, closes, adxPeriod);
        const atr = calculateATR(highs, lows, closes, adxPeriod);

        return [
            { name: 'DC Upper', type: 'line', values: upper, color: COLORS.Channel },
            { name: 'DC Middle', type: 'line', values: middle, color: COLORS.Channel },
            { name: 'DC Lower', type: 'line', values: lower, color: COLORS.Channel },
            { name: 'ADX', type: 'line', values: adx, color: COLORS.Neutral },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Positive },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
    },
};
