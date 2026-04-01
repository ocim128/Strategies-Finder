import { expect } from 'chai';
import { describe, it } from 'node:test';
import { close_percentile_range_entry } from '../lib/strategies/lib/close_percentile_range_entry';

describe('close_percentile_range_entry', () => {
    it('keeps historical signals stable when later bars are appended', () => {
        const closes = [100, 100, 100, 100, 100, 90, 110, 100, 120, 80, 130, 70, 140, 60, 150, 50, 160];
        const bars = closes.map((close, index) => {
            const open = index === 0 ? close : closes[index - 1];
            return {
                time: index + 1,
                open,
                high: Math.max(open, close) + 1,
                low: Math.min(open, close) - 1,
                close,
                volume: 1000,
            };
        });
        const params = { rangeWindow: 5, entryPercentile: 20, confirmationBars: 1 };

        const fullSignals = close_percentile_range_entry.execute(bars, params);
        expect(fullSignals.length).to.be.greaterThan(0);

        for (let prefix = params.rangeWindow + 1; prefix <= bars.length; prefix++) {
            const prefixSignals = close_percentile_range_entry.execute(bars.slice(0, prefix), params);
            const prefixKeys = prefixSignals.map((signal) => `${signal.barIndex}|${signal.type}`);
            const fullKeys = fullSignals
                .filter((signal) => typeof signal.barIndex === 'number' && signal.barIndex < prefix)
                .map((signal) => `${signal.barIndex}|${signal.type}`);

            expect(prefixKeys, `signal mismatch at prefix ${prefix}`).to.deep.equal(fullKeys);
        }
    });
});
