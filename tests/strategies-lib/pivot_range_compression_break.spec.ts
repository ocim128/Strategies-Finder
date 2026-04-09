import { expect } from 'chai';
import { describe, it } from 'node:test';
import { pivot_range_compression_break } from '../lib/strategies/lib/pivot_range_compression_break';

describe('pivot_range_compression_break', () => {
    it('keeps historical signals stable when later bars are appended', () => {
        const closes = [
            98.59, 102.16, 108.11, 104.03, 100.54, 97.33, 97.03, 98.33, 96.09, 97.97,
            95.68, 91.86, 90.28, 94.51, 98.19, 103.73, 108.2, 112.1, 109.17, 104.79,
            110.76, 109.34, 113.3, 113.59, 119.54, 116.64, 121.31, 120.78, 118.55, 116.7,
        ];
        const bars = closes.map((close, index) => {
            const open = index === 0 ? close : closes[index - 1];
            const wiggle = 0.5 + (index % 3) * 0.25;
            return {
                time: index + 1,
                open,
                high: Math.max(open, close) + wiggle,
                low: Math.min(open, close) - wiggle,
                close,
                volume: 1000,
            };
        });
        const params = { pivotLookback: 6, compressionRank: 60 };

        const fullSignals = pivot_range_compression_break.execute(bars, params);
        expect(fullSignals.length).to.be.greaterThan(0);

        for (let prefix = params.pivotLookback * 2 + 1; prefix <= bars.length; prefix++) {
            const prefixSignals = pivot_range_compression_break.execute(bars.slice(0, prefix), params);
            const prefixKeys = prefixSignals.map((signal) => `${signal.barIndex}|${signal.type}`);
            const fullKeys = fullSignals
                .filter((signal) => typeof signal.barIndex === 'number' && signal.barIndex < prefix)
                .map((signal) => `${signal.barIndex}|${signal.type}`);

            expect(prefixKeys, `signal mismatch at prefix ${prefix}`).to.deep.equal(fullKeys);
        }
    });
});
