import { expect } from 'chai';
import { describe, it } from 'node:test';
import { clamp, createSeededRandom, roundRangeValue, snapValueToStepRange } from '../lib/param-math-utils';

/**
 * Shared numeric helpers for parameter ranges and deterministic sweeps. The
 * step snapping is used to reconcile UI/persisted values with a declared
 * range, and the seeded RNG underpins reproducible optimization runs.
 */

describe('param-math-utils: roundRangeValue', () => {
    it('rounds to three decimal places', () => {
        expect(roundRangeValue(1.23456)).to.equal(1.235);
        expect(roundRangeValue(1.23449)).to.equal(1.234);
        expect(roundRangeValue(-1.2346)).to.equal(-1.235);
        expect(roundRangeValue(2)).to.equal(2);
    });
});

describe('param-math-utils: snapValueToStepRange', () => {
    const range = { min: 0, max: 10, step: 2 };

    it('snaps to the nearest step multiple', () => {
        expect(snapValueToStepRange(range, 3.1)).to.equal(4);
        expect(snapValueToStepRange(range, 3.9)).to.equal(4);
        expect(snapValueToStepRange(range, 2.1)).to.equal(2);
        expect(snapValueToStepRange(range, 4)).to.equal(4);
    });

    it('clamps above the maximum and below the minimum', () => {
        expect(snapValueToStepRange(range, 100)).to.equal(10);
        expect(snapValueToStepRange(range, -5)).to.equal(0);
    });

    it('returns the rounded minimum for non-finite input', () => {
        expect(snapValueToStepRange(range, Number.NaN)).to.equal(0);
        expect(snapValueToStepRange(range, Number.POSITIVE_INFINITY)).to.equal(0);
    });

    it('honors a non-zero minimum and a fractional step', () => {
        const fractional = { min: 1, max: 2, step: 0.25 };
        expect(snapValueToStepRange(fractional, 1.3)).to.equal(1.25);
        expect(snapValueToStepRange(fractional, 1.9)).to.equal(2);
        expect(snapValueToStepRange(fractional, 0)).to.equal(1);
    });

    it('collapses a degenerate range (min === max) onto the single value', () => {
        const degenerate = { min: 5, max: 5, step: 1 };
        expect(snapValueToStepRange(degenerate, 3)).to.equal(5);
        expect(snapValueToStepRange(degenerate, 9)).to.equal(5);
    });
});

describe('param-math-utils: clamp', () => {
    it('returns the value unchanged when inside [min, max]', () => {
        expect(clamp(5, 0, 10)).to.equal(5);
        expect(clamp(0, 0, 10)).to.equal(0);
        expect(clamp(10, 0, 10)).to.equal(10);
    });

    it('clamps below the minimum and above the maximum', () => {
        expect(clamp(-3, 0, 10)).to.equal(0);
        expect(clamp(15, 0, 10)).to.equal(10);
    });

    it('collapses a degenerate range (min === max) onto that value', () => {
        expect(clamp(3, 2, 2)).to.equal(2);
        expect(clamp(9, 2, 2)).to.equal(2);
    });
});

describe('param-math-utils: createSeededRandom', () => {
    it('is deterministic for the same seed', () => {
        const first = createSeededRandom(42);
        const second = createSeededRandom(42);
        const firstSequence = Array.from({ length: 5 }, () => first());
        const secondSequence = Array.from({ length: 5 }, () => second());
        expect(firstSequence).to.deep.equal(secondSequence);
    });

    it('produces different streams for different seeds', () => {
        const a = createSeededRandom(1);
        const b = createSeededRandom(2);
        expect(a()).to.not.equal(b());
    });

    it('stays within [0, 1)', () => {
        const next = createSeededRandom(7);
        for (let i = 0; i < 200; i += 1) {
            const value = next();
            expect(value).to.be.at.least(0);
            expect(value).to.be.lessThan(1);
        }
    });

    it('treats a zero seed as a valid (non-degenerate) stream', () => {
        const zero = createSeededRandom(0);
        const explicitOne = createSeededRandom(1);
        expect(zero()).to.equal(explicitOne());
    });
});
