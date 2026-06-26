import { expect } from 'chai';
import { describe, it } from 'node:test';
import { buildPivotFlags } from '../lib/strategies/strategy-helpers';

describe('Pivot Flags', () => {
    it('strict pivot flags should match expected extrema behavior', () => {
        const highs = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const lows = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const flags = buildPivotFlags(highs, lows, 1, 'strict');

        expect(flags.pivotHighs[3]).to.equal(true);
        expect(flags.pivotLows[5]).to.equal(true);
        expect(flags.pivotHighs[7]).to.equal(true);
    });
});
