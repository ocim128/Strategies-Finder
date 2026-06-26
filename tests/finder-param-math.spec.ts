import { expect } from 'chai';
import { describe, it } from 'node:test';
import { computeParamRange, normalizeParamValue } from '../lib/finder/finder-param-math';

describe('Finder param math', () => {
    it('applies Finder-only bounds to midpointBars when requested', () => {
        const finderRange = computeParamRange('midpointBars', 10, 50, { includeFinderExtraBounds: true });
        const genericRange = computeParamRange('midpointBars', 10, 50);

        expect(finderRange).to.deep.equal({ min: 5, max: 6 });
        expect(genericRange).to.deep.equal({ min: 5, max: 15 });
    });

    it('applies Finder-only normalization to crossThreshold when requested', () => {
        const finderValue = normalizeParamValue('crossThreshold', 0.08, 0.02, { includeFinderExtraBounds: true });
        const genericValue = normalizeParamValue('crossThreshold', 0.08, 0.02);

        expect(finderValue).to.equal(0.05);
        expect(genericValue).to.equal(0.08);
    });

    it('still honors explicit mutation bounds for shared genetic normalization', () => {
        const normalized = normalizeParamValue('takeProfitPercent', 120, 25, { min: 0, max: 80 });

        expect(normalized).to.equal(80);
    });
});
