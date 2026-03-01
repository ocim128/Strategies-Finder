import { expect } from 'chai';
import { describe, it } from 'node:test';
import { shouldUseRustCachedMode } from './lib/finder/finder-runner';

describe('Finder adaptive cache mode decision', () => {
    it('enables cache for large dataset (>500k bars)', () => {
        const result = shouldUseRustCachedMode(600_000, 100, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('disables cache for small dataset with low batch count', () => {
        const result = shouldUseRustCachedMode(100_000, 50, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('enables cache for small dataset with high batch count (>=8)', () => {
        // 200 runs / 20 batch size = 10 batches (>= 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 200, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('disables cache when batch count is just below threshold', () => {
        // 140 runs / 20 batch size = 7 batches (< 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 140, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('enables cache when batch count is exactly at threshold', () => {
        // 160 runs / 20 batch size = 8 batches (== 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 160, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('respects custom minBatchesForCache option', () => {
        // With custom threshold of 5, 100 runs / 20 = 5 batches should trigger
        const result = shouldUseRustCachedMode(100_000, 100, 20, { minBatchesForCache: 5 });
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('large dataset takes precedence over batch count', () => {
        // Even with low batch count, large dataset should enable cache
        const result = shouldUseRustCachedMode(600_000, 10, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('handles edge case at exactly 500k bars (not large)', () => {
        // Exactly 500k is the threshold, not > 500k
        const result = shouldUseRustCachedMode(500_000, 100, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('handles edge case just above 500k bars', () => {
        const result = shouldUseRustCachedMode(500_001, 100, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('handles zero batch size safely', () => {
        const result = shouldUseRustCachedMode(100_000, 1, 0);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });
});
