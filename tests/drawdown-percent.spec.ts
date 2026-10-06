import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateMaxDrawdown } from '../lib/strategies/backtest/position-stats';
import {
    calculateMaxDrawdown as calculatePathAnalyzerMaxDrawdown,
} from '../lib/strategies/monte-carlo/path-dependency-analyzer';
import type { EquityCurvePoint } from '../lib/strategies/monte-carlo/types';
import type { Time } from '../lib/types/strategies';

function curve(values: number[]): { time: Time; value: number }[] {
    return values.map((value, index) => ({ time: index as Time, value }));
}

describe('maximum percentage drawdown is independent of the worst dollar drawdown', () => {
    it('reports the deepest relative loss from an earlier smaller peak', () => {
        // 10000 -> 5000 -> 100000 -> 90000: the worst dollar loss (10000)
        // happens after the worst relative loss (50% from the 10000 peak).
        const result = calculateMaxDrawdown(curve([10000, 5000, 100000, 90000]), 10000);
        expect(result.maxDrawdown).to.equal(10000);
        expect(result.maxDrawdownPercent).to.equal(50);
    });

    it('keeps equal dollar losses at different peaks from hiding the deeper relative loss', () => {
        const result = calculateMaxDrawdown(curve([10000, 9000, 100000, 99000]), 10000);
        expect(result.maxDrawdown).to.equal(1000);
        expect(result.maxDrawdownPercent).to.equal(10);
    });

    it('reports 100 percent at zero equity and beyond for negative equity', () => {
        const zero = calculateMaxDrawdown(curve([10000, 0]), 10000);
        expect(zero.maxDrawdown).to.equal(10000);
        expect(zero.maxDrawdownPercent).to.equal(100);

        const negative = calculateMaxDrawdown(curve([10000, -5000]), 10000);
        expect(negative.maxDrawdown).to.equal(15000);
        expect(negative.maxDrawdownPercent).to.equal(150);
    });

    it('keeps the nonpositive-peak guard at zero percent', () => {
        const result = calculateMaxDrawdown(curve([-1000, -3000, -2000]), -1000);
        expect(result.maxDrawdown).to.equal(2000);
        expect(result.maxDrawdownPercent).to.equal(0);
    });

    it('returns zeros for an empty curve', () => {
        const result = calculateMaxDrawdown([], 10000);
        expect(result.maxDrawdown).to.equal(0);
        expect(result.maxDrawdownPercent).to.equal(0);
    });
});

describe('path analyzer drawdown helper', () => {
    it('reports the worst relative loss while anchoring start/end to the dollar maximum', () => {
        const points: EquityCurvePoint[] = [10000, 5000, 100000, 90000].map((equity, bar) => ({
            bar,
            equity,
            cumulativeReturn: 0,
        }));
        const result = calculatePathAnalyzerMaxDrawdown(points, 10000);
        expect(result.maxDrawdown).to.equal(10000);
        expect(result.maxDrawdownPercent).to.equal(50);
        // Dollar-drawdown start/end semantics stay tied to the worst dollar loss.
        expect(result.drawdownStart).to.equal(2);
        expect(result.drawdownEnd).to.equal(3);
    });
});
