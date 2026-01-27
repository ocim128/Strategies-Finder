import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateCopulaDependence, waveletDecompose, calculateTransferEntropy } from './lib/pairCombiner';

describe('Pair Combiner Analysis', () => {
    it('should detect positive dependence in copula metrics', () => {
        const returns1 = [0.01, 0.02, 0.03, 0.015, 0.04, 0.05, 0.02, 0.01, 0.03, 0.04];
        const returns2 = [0.012, 0.021, 0.029, 0.014, 0.039, 0.052, 0.019, 0.011, 0.031, 0.038];
        const result = calculateCopulaDependence(returns1, returns2);
        expect(result.kendallTau).to.be.greaterThan(0);
        expect(result.tailDependence.upper).to.be.at.least(0);
    });

    it('should return wavelet output with matching length', () => {
        const spread = [1, 2, 3, 4, 3, 2, 1, 0];
        const result = waveletDecompose(spread, 'haar', 3);
        expect(result.smoothedSpread.length).to.equal(spread.length);
        expect(result.noiseRatio).to.be.at.least(0);
        expect(result.noiseRatio).to.be.at.most(1);
    });

    it('should keep transfer entropy net flow near neutral for symmetric series', () => {
        const returns1 = [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.015, -0.015];
        const returns2 = [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.015, -0.015];
        const result = calculateTransferEntropy(returns1, returns2, 1, 6);
        expect(Math.abs(result.netFlow)).to.be.lessThan(0.3);
    });
});
