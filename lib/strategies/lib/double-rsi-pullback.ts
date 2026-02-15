import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateRSI } from '../indicators';

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export const double_rsi_pullback: Strategy = {
    name: 'Double RSI Pullback',
    description: 'Uses long-term RSI for regime and short-term RSI pullbacks for entries, with symmetric long/short exits.',
    defaultParams: {
        trendRsiLen: 100,
        entryRsiLen: 14,
        oversoldLevel: 30
    },
    paramLabels: {
        trendRsiLen: 'Trend RSI Length',
        entryRsiLen: 'Entry RSI Length',
        oversoldLevel: 'Oversold Level'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const trendRsiLen = Math.max(2, Math.round(params.trendRsiLen ?? 100));
        const entryRsiLen = Math.max(2, Math.round(params.entryRsiLen ?? 14));
        const oversoldLevel = clamp(params.oversoldLevel ?? 30, 5, 45);
        const overboughtLevel = 100 - oversoldLevel;

        const closes = getCloses(cleanData);
        const trendRsi = calculateRSI(closes, trendRsiLen);
        const entryRsi = calculateRSI(closes, entryRsiLen);

        const signals: Signal[] = [];
        let position: 'flat' | 'long' | 'short' = 'flat';

        for (let i = 1; i < cleanData.length; i++) {
            const trendNow = trendRsi[i];
            const entryPrev = entryRsi[i - 1];
            const entryNow = entryRsi[i];
            if (trendNow === null || entryPrev === null || entryNow === null) continue;

            if (position === 'long') {
                const crossedAboveMidline = entryPrev < 50 && entryNow >= 50;
                const reachedOverbought = entryNow >= overboughtLevel;
                if (crossedAboveMidline || reachedOverbought) {
                    signals.push(createSellSignal(
                        cleanData,
                        i,
                        reachedOverbought ? 'Double RSI long overbought exit' : 'Double RSI long midline exit'
                    ));
                    position = 'flat';
                }
                continue;
            }

            if (position === 'short') {
                const crossedBelowMidline = entryPrev > 50 && entryNow <= 50;
                const reachedOversold = entryNow <= oversoldLevel;
                if (crossedBelowMidline || reachedOversold) {
                    signals.push(createBuySignal(
                        cleanData,
                        i,
                        reachedOversold ? 'Double RSI short oversold exit' : 'Double RSI short midline exit'
                    ));
                    position = 'flat';
                }
                continue;
            }

            const bullishRegime = trendNow > 50;
            const bearishRegime = trendNow < 50;
            const longTrigger = entryPrev > oversoldLevel && entryNow <= oversoldLevel;
            const shortTrigger = entryPrev < overboughtLevel && entryNow >= overboughtLevel;

            if (bullishRegime && longTrigger) {
                signals.push(createBuySignal(cleanData, i, 'Double RSI long pullback entry'));
                position = 'long';
            } else if (bearishRegime && shortTrigger) {
                signals.push(createSellSignal(cleanData, i, 'Double RSI short pullback entry'));
                position = 'short';
            }
        }

        if (position === 'long' && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'Double RSI final close'));
        } else if (position === 'short' && cleanData.length > 0) {
            signals.push(createBuySignal(cleanData, cleanData.length - 1, 'Double RSI final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['trendRsiLen', 'entryRsiLen', 'oversoldLevel']
    }
};
