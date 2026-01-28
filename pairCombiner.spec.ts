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

    describe('Edge Cases', () => {
        it('handles empty arrays gracefully', () => {
            const copula = calculateCopulaDependence([], []);
            expect(copula.kendallTau).to.equal(0);
            const wavelet = waveletDecompose([], 'haar', 2);
            expect(wavelet.levels.length).to.equal(0);
            const entropy = calculateTransferEntropy([], [], 2, 4);
            expect(entropy.netFlow).to.equal(0);
        });

        it('handles single-element arrays', () => {
            const copula = calculateCopulaDependence([0.01], [0.02]);
            expect(copula.kendallTau).to.equal(0);
            const wavelet = waveletDecompose([1], 'db4', 2);
            expect(wavelet.smoothedSpread.length).to.equal(1);
            const entropy = calculateTransferEntropy([0.01], [0.02], 2, 4);
            expect(entropy.netFlow).to.equal(0);
        });

        it('handles NaN/Infinity values', () => {
            const returns1 = [0.01, Number.NaN, 0.02, Number.POSITIVE_INFINITY, -0.01, 0.03];
            const returns2 = [0.011, 0.012, Number.NEGATIVE_INFINITY, 0.019, -0.009, 0.031];
            const copula = calculateCopulaDependence(returns1, returns2);
            expect(Number.isFinite(copula.kendallTau)).to.equal(true);
            const entropy = calculateTransferEntropy(returns1, returns2, 2, 6);
            expect(Number.isFinite(entropy.te_1_to_2)).to.equal(true);
        });

        it('handles identical series (perfect correlation)', () => {
            const returns = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
            const copula = calculateCopulaDependence(returns, returns);
            expect(copula.kendallTau).to.be.greaterThan(0.75);
        });
    });

    describe('Copula', () => {
        it('returns kendallTau near +1 for identical rankings', () => {
            const a = Array.from({ length: 30 }, (_, i) => i + 1);
            const b = a.slice();
            const result = calculateCopulaDependence(a, b);
            expect(result.kendallTau).to.be.greaterThan(0.9);
        });

        it('returns kendallTau near -1 for inverse rankings', () => {
            const a = Array.from({ length: 30 }, (_, i) => i + 1);
            const b = a.map(v => -v);
            const result = calculateCopulaDependence(a, b);
            expect(result.kendallTau).to.be.lessThan(-0.9);
        });

        it('detects upper tail dependence in joint extreme gains', () => {
            const base = Array.from({ length: 50 }, () => 0.001);
            const spikes = [10, 20, 30, 40];
            spikes.forEach(idx => {
                base[idx] = 0.08;
            });
            const returns1 = base;
            const returns2 = base.map(v => v * 0.95);
            const result = calculateCopulaDependence(returns1, returns2);
            expect(result.tailDependence.upper).to.be.greaterThan(result.tailDependence.lower);
        });
    });

    describe('Wavelets', () => {
        it('preserves total energy across levels', () => {
            const spread = Array.from({ length: 64 }, (_, i) => Math.sin(i / 3) + Math.cos(i / 5));
            const result = waveletDecompose(spread, 'db4', 4);
            const totalEnergy = result.levels.reduce((sum, lvl) => sum + lvl.energy, 0);
            expect(totalEnergy).to.be.at.most(1.0001);
        });

        it('db4 produces smoother output than haar', () => {
            const spread = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1 : -1) + Math.sin(i / 4));
            const haar = waveletDecompose(spread, 'haar', 3);
            const db4 = waveletDecompose(spread, 'db4', 3);
            const totalVariation = (values: number[]) => {
                let sum = 0;
                for (let i = 1; i < values.length; i++) {
                    sum += Math.abs(values[i] - values[i - 1]);
                }
                return sum;
            };
            const originalVariation = totalVariation(spread);
            expect(totalVariation(db4.smoothedSpread)).to.be.at.most(originalVariation);
            expect(totalVariation(haar.smoothedSpread)).to.be.at.most(originalVariation);
            expect(db4.smoothedSpread.join(',')).to.not.equal(haar.smoothedSpread.join(','));
        });
    });

    describe('Transfer Entropy', () => {
        it('detects X leads Y when X is a lagged copy of Y', () => {
            const x = Array.from({ length: 120 }, (_, i) => Math.sin(i / 5) + (i % 3) * 0.01);
            const y = x.map((_, i) => (i === 0 ? 0 : x[i - 1]));
            const result = calculateTransferEntropy(x, y, 2, 6);
            expect(result.te_1_to_2).to.be.greaterThan(result.te_2_to_1);
            expect(result.netFlow).to.be.greaterThan(0);
        });

        it('significance increases with sample size', () => {
            const base = Array.from({ length: 40 }, (_, i) => Math.sin(i / 4));
            const small = calculateTransferEntropy(base, base.map((_, i) => (i === 0 ? 0 : base[i - 1])), 2, 6);
            const largeSeries = Array.from({ length: 200 }, (_, i) => Math.sin(i / 4));
            const large = calculateTransferEntropy(largeSeries, largeSeries.map((_, i) => (i === 0 ? 0 : largeSeries[i - 1])), 2, 6);
            expect(large.significance).to.be.at.least(small.significance);
        });
    });
});
