import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Time, Trade } from './lib/strategies/index';
import { computeEdgeRatios, computeStreakAnalysis, computeTTest } from './lib/strategies/backtest/edge-statistics';

function makeTrade(id: number, pnlPercent: number, entryTime: Time, exitTime: Time, type: 'long' | 'short' = 'long'): Trade {
    return {
        id,
        type,
        entryTime,
        entryPrice: 100,
        exitTime,
        exitPrice: 100 * (1 + pnlPercent / 100),
        pnl: pnlPercent,
        pnlPercent,
        size: 1,
        exitReason: 'signal',
    };
}

describe('Edge statistics', () => {
    it('uses canonical time keys so BusinessDay bars map correctly', () => {
        const data: OHLCVData[] = [
            { time: { year: 2026, month: 1, day: 1 } as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: { year: 2026, month: 1, day: 2 } as Time, open: 100, high: 105, low: 95, close: 102, volume: 1 },
            { time: { year: 2026, month: 1, day: 3 } as Time, open: 102, high: 106, low: 100, close: 103, volume: 1 },
        ];
        const trades: Trade[] = [
            makeTrade(
                1,
                3,
                { year: 2026, month: 1, day: 1 } as Time,
                { year: 2026, month: 1, day: 3 } as Time
            ),
        ];

        const ratios = computeEdgeRatios(trades, data, [1, 2]);
        expect(ratios.length).to.equal(2);
        expect(ratios[0].sampleSize).to.equal(1);
        expect(ratios[1].sampleSize).to.equal(1);
    });

    it('requires full N-bar horizon samples for edge ratio windows', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 102, low: 99, close: 100, volume: 1 },
            { time: 2 as Time, open: 100, high: 105, low: 95, close: 101, volume: 1 },
            { time: 3 as Time, open: 101, high: 104, low: 98, close: 102, volume: 1 },
            { time: 4 as Time, open: 102, high: 103, low: 101, close: 102, volume: 1 },
        ];
        const trades: Trade[] = [
            makeTrade(1, 2, 1 as Time, 3 as Time), // full +2 bars available
            makeTrade(2, -1, 3 as Time, 4 as Time), // only +1 bar available, should be skipped for horizon=2
        ];

        const ratios = computeEdgeRatios(trades, data, [2]);
        expect(ratios.length).to.equal(1);
        expect(ratios[0].sampleSize).to.equal(1);
    });

    it('marks zero-variance non-zero returns as highly significant', () => {
        const trades: Trade[] = [
            makeTrade(1, 1, 1 as Time, 2 as Time),
            makeTrade(2, 1, 2 as Time, 3 as Time),
            makeTrade(3, 1, 3 as Time, 4 as Time),
        ];

        const t = computeTTest(trades);
        expect(t.stdDev).to.equal(0);
        expect(t.tStatistic).to.equal(Number.POSITIVE_INFINITY);
        expect(t.pValue).to.equal(0);
        expect(t.isSignificant).to.equal(true);
        expect(t.confidence).to.equal('very_high');
    });

    it('separates win clustering from adverse loss clustering', () => {
        const outcomes: number[] = [];
        for (let i = 0; i < 30; i++) outcomes.push(i % 2 === 0 ? 1 : -1);
        for (let i = 0; i < 20; i++) outcomes.push(-1);
        for (let i = 0; i < 30; i++) outcomes.push(i % 2 === 0 ? 1 : -1);

        const trades = outcomes.map((pnl, i) => makeTrade(i + 1, pnl, i as Time, (i + 1) as Time));
        const streaks = computeStreakAnalysis(trades);

        expect(streaks.hasRegimeClustering).to.equal(true);
        expect(streaks.hasWinRegimeClustering).to.equal(false);
        expect(streaks.hasLossRegimeClustering).to.equal(true);
    });
});
