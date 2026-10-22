import { expect } from 'chai';
import { describe, it } from 'node:test';
import { parseTimeToUnixSeconds } from '../lib/time-normalization';

/**
 * The single normalizer every time shape funnels through (numbers, numeric
 * strings, ISO strings and lightweight-charts business days). Candle trimming,
 * signal ordering and the Rust result validator all depend on its exact
 * milliseconds-vs-seconds detection and its null contract.
 */

describe('time-normalization: numeric inputs', () => {
    it('passes through second timestamps', () => {
        expect(parseTimeToUnixSeconds(1_700_000_000)).to.equal(1_700_000_000);
    });

    it('detects millisecond timestamps and downscales them', () => {
        expect(parseTimeToUnixSeconds(1_700_000_000_000)).to.equal(1_700_000_000);
    });

    it('keeps values at or below the seconds ceiling as seconds', () => {
        expect(parseTimeToUnixSeconds(9_999_999_999)).to.equal(9_999_999_999);
        expect(parseTimeToUnixSeconds(10_000_000_000)).to.equal(10_000_000);
    });

    it('floors fractional seconds and preserves negatives', () => {
        expect(parseTimeToUnixSeconds(1.9)).to.equal(1);
        expect(parseTimeToUnixSeconds(-100)).to.equal(-100);
        expect(parseTimeToUnixSeconds(0)).to.equal(0);
    });

    it('rejects non-finite numbers', () => {
        expect(parseTimeToUnixSeconds(Number.NaN)).to.equal(null);
        expect(parseTimeToUnixSeconds(Number.POSITIVE_INFINITY)).to.equal(null);
    });
});

describe('time-normalization: string inputs', () => {
    it('parses numeric strings as timestamps', () => {
        expect(parseTimeToUnixSeconds('1700000000')).to.equal(1_700_000_000);
        expect(parseTimeToUnixSeconds('1.9')).to.equal(1);
    });

    it('parses ISO date strings', () => {
        expect(parseTimeToUnixSeconds('2023-11-14T22:13:20.000Z')).to.equal(1_700_000_000);
    });

    it('rejects blank and unparseable strings', () => {
        expect(parseTimeToUnixSeconds('')).to.equal(null);
        expect(parseTimeToUnixSeconds('   ')).to.equal(null);
        expect(parseTimeToUnixSeconds('not-a-time')).to.equal(null);
    });
});

describe('time-normalization: business-day objects', () => {
    it('converts a business day to UTC seconds', () => {
        expect(parseTimeToUnixSeconds({ year: 2023, month: 11, day: 15 })).to.equal(1_700_006_400);
    });

    it('rejects objects without a year or with non-numeric parts', () => {
        expect(parseTimeToUnixSeconds({})).to.equal(null);
        expect(parseTimeToUnixSeconds({ year: 2023, month: 11 })).to.equal(null);
        expect(parseTimeToUnixSeconds({ year: 'x', month: 1, day: 1 })).to.equal(null);
    });

    it('returns null for business days outside the Date range', () => {
        for (const year of [300_000, -300_000, Number.MAX_VALUE]) {
            expect(parseTimeToUnixSeconds({ year, month: 1, day: 1 })).to.equal(null);
        }
    });
});

describe('time-normalization: unsupported inputs', () => {
    it('returns null for null, undefined, booleans and arrays', () => {
        expect(parseTimeToUnixSeconds(null)).to.equal(null);
        expect(parseTimeToUnixSeconds(undefined)).to.equal(null);
        expect(parseTimeToUnixSeconds(true)).to.equal(null);
        expect(parseTimeToUnixSeconds([1, 2])).to.equal(null);
    });
});
