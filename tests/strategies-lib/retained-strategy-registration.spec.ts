import { expect } from 'chai';
import { describe, it } from 'node:test';
import { strategies } from '../lib/strategies/library';

describe('retained strategy library registration', () => {
    it('keeps the retained survival strategy libs registered', () => {
        const retainedKeys = [
            'macd_signal_pinch_explosion',
            'macd_histogram_volatility_squeeze',
            'volume_profile_poc_median_shift',
        ];

        for (const key of retainedKeys) {
            const strategy = strategies[key];
            expect(strategy, `missing strategy ${key}`).to.not.equal(undefined);
            expect(Object.keys(strategy.paramLabels), `${key} paramLabels drift`).to.deep.equal(Object.keys(strategy.defaultParams));

            if (typeof strategy.normalizeParams === 'function') {
                const normalizedDefaults = strategy.normalizeParams(strategy.defaultParams);
                for (const paramKey of Object.keys(strategy.defaultParams)) {
                    expect(normalizedDefaults[paramKey], `${key}.${paramKey} default should already be normalized`).to.equal(strategy.defaultParams[paramKey]);
                }
            }
        }
    });
});
