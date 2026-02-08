import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from '../strategy-helpers';
import { COLORS } from '../constants';

export const gap_fail_reversal: Strategy = {
    name: 'Gap Fail Reversal',
    description: 'Fades opening gaps that fail to hold and quickly reclaim the prior session range boundary.',
    defaultParams: {
        minGapPct: 0.35,
        maxFailBars: 3
    },
    paramLabels: {
        minGapPct: 'Minimum Gap (%)',
        maxFailBars: 'Max Bars To Fail'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const minGapPct = Math.max(0.05, params.minGapPct ?? 0.35);
        const maxFailBars = Math.max(1, Math.round(params.maxFailBars ?? 3));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const gapThreshold = minGapPct / 100;

        type PendingGap = {
            dir: 'up' | 'down';
            level: number;
            startIndex: number;
        } | null;

        let pending: PendingGap = null;

        const passthrough = new Array<number>(cleanData.length).fill(0);
        return createSignalLoop(cleanData, [passthrough], (i) => {
            if (pending && i - pending.startIndex > maxFailBars) {
                pending = null;
            }

            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];
            const open = cleanData[i].open;
            const close = cleanData[i].close;

            if (!pending) {
                const gapUp = open > prevHigh * (1 + gapThreshold);
                const gapDown = open < prevLow * (1 - gapThreshold);
                if (gapUp) {
                    pending = { dir: 'up', level: prevHigh, startIndex: i };
                } else if (gapDown) {
                    pending = { dir: 'down', level: prevLow, startIndex: i };
                }
            }

            if (!pending) return null;

            if (pending.dir === 'up' && close < pending.level) {
                pending = null;
                return createSellSignal(cleanData, i, 'Gap Up Fail');
            }

            if (pending.dir === 'down' && close > pending.level) {
                pending = null;
                return createBuySignal(cleanData, i, 'Gap Down Fail');
            }

            return null;
        });
    },
    indicators: (data: OHLCVData[]): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const prevHigh: (number | null)[] = cleanData.map((_, i) => i === 0 ? null : cleanData[i - 1].high);
        const prevLow: (number | null)[] = cleanData.map((_, i) => i === 0 ? null : cleanData[i - 1].low);

        return [
            { name: 'Prev High', type: 'line', values: prevHigh, color: COLORS.Channel },
            { name: 'Prev Low', type: 'line', values: prevLow, color: COLORS.Channel }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['minGapPct', 'maxFailBars']
    }
};
