import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createSignalLoop } from '../strategy-helpers';
import { calculateRSI, calculateMACD } from '../indicators';
import { COLORS } from '../constants';

export const rsi_macd_combo: Strategy = {
    name: 'RSI + MACD Combo',
    description: 'Combines RSI and MACD signals for higher probability trades',
    defaultParams: { rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65, macdFast: 12, macdSlow: 26, macdSignal: 9 },
    paramLabels: { rsiPeriod: 'RSI Period', rsiOversold: 'RSI Oversold', rsiOverbought: 'RSI Overbought', macdFast: 'MACD Fast', macdSlow: 'MACD Slow', macdSignal: 'MACD Signal' },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const closes = data.map(d => d.close);
        const rsi = calculateRSI(closes, params.rsiPeriod);
        const { macd, signal } = calculateMACD(closes, params.macdFast, params.macdSlow, params.macdSignal);

        // This strategy checks previous values too in the loop, so createSignalLoop handles it.
        // But note: the original code had: hasNullValues([rsi, macd, signal], i - 1) too.
        // createSignalLoop checks 'i' for nulls. If we need 'i-1' check, we should manually check it inside.
        // Actually, hasNullValues checks i and i-1 in strategy-helpers usually.
        // Let's check strategy-helpers again.

        return createSignalLoop(data, [rsi, macd, signal], (i) => {
            // strategy-helpers `hasNullValues` checks i and i-1. So we are safe.

            // Buy: RSI was oversold and MACD crosses above signal
            const rsiRecovering = rsi[i - 1]! <= params.rsiOversold && rsi[i]! > params.rsiOversold;
            const macdBullish = macd[i - 1]! <= signal[i - 1]! && macd[i]! > signal[i]!;

            if (rsiRecovering || (macdBullish && rsi[i]! < 50)) {
                return {
                    time: data[i].time,
                    type: 'buy',
                    price: data[i].close,
                    reason: rsiRecovering ? 'RSI recovering from oversold' : 'MACD bullish with RSI confirmation'
                };
            }

            // Sell: RSI was overbought and MACD crosses below signal
            const rsiDropping = rsi[i - 1]! >= params.rsiOverbought && rsi[i]! < params.rsiOverbought;
            const macdBearish = macd[i - 1]! >= signal[i - 1]! && macd[i]! < signal[i]!;

            if (rsiDropping || (macdBearish && rsi[i]! > 50)) {
                return {
                    time: data[i].time,
                    type: 'sell',
                    price: data[i].close,
                    reason: rsiDropping ? 'RSI dropping from overbought' : 'MACD bearish with RSI confirmation'
                };
            }
            return null;
        });
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const closes = data.map(d => d.close);
        const { macd, signal } = calculateMACD(closes, params.macdFast, params.macdSlow, params.macdSignal);
        return [
            { name: 'RSI', type: 'line', values: calculateRSI(closes, params.rsiPeriod), color: COLORS.Neutral },
            { name: 'MACD', type: 'line', values: macd, color: COLORS.Fast },
            { name: 'Signal', type: 'line', values: signal, color: COLORS.Slow }
        ];
    }
};
