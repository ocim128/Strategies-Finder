import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    FINDER_BATCH_MAX_BODY_BYTES,
    FINDER_MAX_RUNS_MAX,
    FINDER_MAX_RUNS_MIN,
    FINDER_TOP_N_MAX,
    FINDER_TOP_N_MIN,
    clampFinderOptions,
    clampFiniteNumber,
} from '../lib/server-request-limits';

/**
 * These helpers guard the Finder/Batch Vite plugins against typed, persisted or
 * directly-posted control values that could request an outsized workload. The
 * clamps are silent by design, so the exact boundary behavior matters.
 */

describe('server request limits: clampFiniteNumber', () => {
    it('passes through values already inside the range', () => {
        expect(clampFiniteNumber(5, 1, 10)).to.equal(5);
        expect(clampFiniteNumber(1, 1, 10)).to.equal(1);
        expect(clampFiniteNumber(10, 1, 10)).to.equal(10);
    });

    it('clamps values outside the range to the nearest bound', () => {
        expect(clampFiniteNumber(50, 1, 10)).to.equal(10);
        expect(clampFiniteNumber(-5, 1, 10)).to.equal(1);
    });

    it('coerces numeric strings', () => {
        expect(clampFiniteNumber('7', 1, 10)).to.equal(7);
        expect(clampFiniteNumber('42', 1, 10)).to.equal(10);
    });

    it('falls back to the minimum for non-finite or non-numeric input', () => {
        expect(clampFiniteNumber(Number.NaN, 1, 10)).to.equal(1);
        expect(clampFiniteNumber(Number.POSITIVE_INFINITY, 1, 10)).to.equal(1);
        expect(clampFiniteNumber(undefined, 1, 10)).to.equal(1);
        expect(clampFiniteNumber(null, 1, 10)).to.equal(1);
        expect(clampFiniteNumber({}, 1, 10)).to.equal(1);
        expect(clampFiniteNumber('not-a-number', 1, 10)).to.equal(1);
    });
});

describe('server request limits: clampFinderOptions', () => {
    it('clamps topN and maxRuns to the UI-declared ranges', () => {
        const clamped = clampFinderOptions({ topN: 1000, maxRuns: 5000 });
        expect(clamped.topN).to.equal(FINDER_TOP_N_MAX);
        expect(clamped.maxRuns).to.equal(FINDER_MAX_RUNS_MAX);
    });

    it('clamps below the minimum', () => {
        const clamped = clampFinderOptions({ topN: -3, maxRuns: 0 });
        expect(clamped.topN).to.equal(FINDER_TOP_N_MIN);
        expect(clamped.maxRuns).to.equal(FINDER_MAX_RUNS_MIN);
    });

    it('does not mutate the caller object', () => {
        const options = { topN: 1000, maxRuns: 5000 };
        clampFinderOptions(options);
        expect(options.topN).to.equal(1000);
        expect(options.maxRuns).to.equal(5000);
    });

    it('defaults missing or corrupted fields to the minimum', () => {
        const clamped = clampFinderOptions({ topN: Number.NaN, maxRuns: undefined });
        expect(clamped.topN).to.equal(FINDER_TOP_N_MIN);
        expect(clamped.maxRuns).to.equal(FINDER_MAX_RUNS_MIN);
    });

    it('preserves unrelated option fields', () => {
        const clamped = clampFinderOptions({ topN: 10, maxRuns: 10, symbol: 'BTCUSDT' } as {
            topN: number;
            maxRuns: number;
            symbol: string;
        });
        expect((clamped as { symbol: string }).symbol).to.equal('BTCUSDT');
    });
});

describe('server request limits: constants', () => {
    it('keeps the body cap far below the generic 80 MB upload limit', () => {
        expect(FINDER_BATCH_MAX_BODY_BYTES).to.equal(2 * 1024 * 1024);
        expect(FINDER_BATCH_MAX_BODY_BYTES).to.be.lessThan(80 * 1024 * 1024);
    });

    it('exposes the UI-declared Finder bounds', () => {
        expect(FINDER_TOP_N_MIN).to.equal(1);
        expect(FINDER_TOP_N_MAX).to.equal(100);
        expect(FINDER_MAX_RUNS_MIN).to.equal(1);
        expect(FINDER_MAX_RUNS_MAX).to.equal(1000);
    });
});
