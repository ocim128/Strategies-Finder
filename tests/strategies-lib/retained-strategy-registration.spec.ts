import { expect } from 'chai';
import { describe, it } from 'node:test';
import { strategies } from '../../lib/strategies/library';
import { strategyManifest } from '../../lib/strategies/manifest';

describe('strategy library registration', () => {
    it('keeps the generated strategy library aligned with the manifest', () => {
        const manifestKeys = strategyManifest.map((entry) => entry.key).sort((left, right) => left.localeCompare(right));
        const libraryKeys = Object.keys(strategies).sort((left, right) => left.localeCompare(right));

        expect(manifestKeys.length).to.be.greaterThan(0);
        expect(libraryKeys).to.deep.equal(manifestKeys);

        for (const { key, strategy } of strategyManifest) {
            expect(strategies[key], `missing strategy ${key}`).to.equal(strategy);
            expect(Object.keys(strategy.paramLabels), `${key} paramLabels drift`).to.deep.equal(Object.keys(strategy.defaultParams));

            for (const walkForwardParam of strategy.metadata?.walkForwardParams ?? []) {
                expect(walkForwardParam in strategy.defaultParams, `${key} missing default param ${walkForwardParam}`).to.equal(true);
                expect(walkForwardParam in strategy.paramLabels, `${key} missing param label ${walkForwardParam}`).to.equal(true);
            }

            if (typeof strategy.normalizeParams === 'function') {
                const normalizedDefaults = strategy.normalizeParams(strategy.defaultParams);
                for (const paramKey of Object.keys(strategy.defaultParams)) {
                    expect(
                        normalizedDefaults[paramKey],
                        `${key}.${paramKey} default should already be normalized`
                    ).to.equal(strategy.defaultParams[paramKey]);
                }
            }
        }
    });
});
