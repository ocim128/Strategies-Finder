import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Time } from '../lib/types/strategies';
import {
    alignSecondaryToPrimary,
    trimAlignedPair,
    buildRelativeStrength,
    buildRollingPairCorrelation,
    CrossSymbolAlignmentError,
} from '../lib/strategies/lib/cross-symbol-helpers';

// ============================================================================
// Test data helpers
// ============================================================================

function bar(time: number, close: number, volume: number = 100): OHLCVData {
    return { time: time as Time, open: close, high: close, low: close, close, volume };
}

// ============================================================================
// alignSecondaryToPrimary
// ============================================================================

describe('alignSecondaryToPrimary', () => {
    it('returns empty array for empty primary', () => {
        const result = alignSecondaryToPrimary([], [bar(1, 100)]);
        expect(result).to.have.length(0);
    });

    it('returns all nulls for empty secondary', () => {
        const primary = [bar(1, 100), bar(2, 101)];
        const result = alignSecondaryToPrimary(primary, []);
        expect(result).to.deep.equal([null, null]);
    });

    it('aligns equal timestamps', () => {
        const primary = [bar(10, 100), bar(20, 101), bar(30, 102)];
        const secondary = [bar(10, 200), bar(20, 201), bar(30, 202)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result).to.have.length(3);
        expect(result[0]!.close).to.equal(200);
        expect(result[1]!.close).to.equal(201);
        expect(result[2]!.close).to.equal(202);
    });

    it('handles missing leading secondary bars with null', () => {
        const primary = [bar(5, 100), bar(10, 101), bar(15, 102)];
        const secondary = [bar(10, 200), bar(15, 201)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result[0]).to.be.null;
        expect(result[1]!.close).to.equal(200);
        expect(result[2]!.close).to.equal(201);
    });

    it('carries forward last observation (LOCF)', () => {
        // Primary has bars at 10, 20, 30. Secondary only at 10 and 30.
        const primary = [bar(10, 100), bar(20, 101), bar(30, 102)];
        const secondary = [bar(10, 200), bar(30, 202)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result[0]!.close).to.equal(200); // exact match
        expect(result[1]!.close).to.equal(200); // LOCF from t=10
        expect(result[2]!.close).to.equal(202); // exact match
    });

    it('never looks forward', () => {
        // Primary at 5, secondary only at 10.
        const primary = [bar(5, 100), bar(10, 101)];
        const secondary = [bar(10, 200)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result[0]).to.be.null; // No secondary bar <= 5
        expect(result[1]!.close).to.equal(200);
    });

    it('handles secondary bars with gaps', () => {
        const primary = [bar(1, 100), bar(2, 101), bar(3, 102), bar(4, 103), bar(5, 104)];
        const secondary = [bar(1, 200), bar(4, 203)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result[0]!.close).to.equal(200);
        expect(result[1]!.close).to.equal(200); // LOCF
        expect(result[2]!.close).to.equal(200); // LOCF
        expect(result[3]!.close).to.equal(203); // new bar
        expect(result[4]!.close).to.equal(203); // LOCF
    });

    it('output length equals primary length', () => {
        const primary = [bar(1, 100), bar(2, 101), bar(3, 102)];
        const secondary = [bar(1, 200), bar(2, 201), bar(3, 202), bar(4, 203)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result).to.have.length(primary.length);
    });

    it('aligns unix-seconds primary with unix-milliseconds secondary', () => {
        const primary = [bar(1710000000, 100), bar(1710000060, 101)];
        const secondary = [bar(1710000000000, 200), bar(1710000060000, 201)];
        const result = alignSecondaryToPrimary(primary, secondary);
        expect(result[0]!.close).to.equal(200);
        expect(result[1]!.close).to.equal(201);
    });
});

// ============================================================================
// trimAlignedPair
// ============================================================================

describe('trimAlignedPair', () => {
    it('trims leading nulls', () => {
        const primary = [bar(1, 100), bar(2, 101), bar(3, 102), bar(4, 103)];
        const aligned: (OHLCVData | null)[] = [null, null, bar(3, 202), bar(4, 203)];
        const result = trimAlignedPair(primary, aligned, 1);
        expect(result.primaryData).to.have.length(2);
        expect(result.secondaryData).to.have.length(2);
        expect(result.trimmedLeadingBars).to.equal(2);
        expect(result.primaryData[0].close).to.equal(102);
        expect(result.secondaryData[0].close).to.equal(202);
    });

    it('does not trim when no leading nulls', () => {
        const primary = [bar(1, 100), bar(2, 101)];
        const aligned: (OHLCVData | null)[] = [bar(1, 200), bar(2, 201)];
        const result = trimAlignedPair(primary, aligned, 1);
        expect(result.primaryData).to.have.length(2);
        expect(result.trimmedLeadingBars).to.equal(0);
    });

    it('throws when no overlapping bars', () => {
        const primary = [bar(1, 100), bar(2, 101)];
        const aligned: (OHLCVData | null)[] = [null, null];
        expect(() => trimAlignedPair(primary, aligned)).to.throw(CrossSymbolAlignmentError);
    });

    it('throws when aligned length is below minBars', () => {
        const primary = [bar(1, 100), bar(2, 101), bar(3, 102)];
        const aligned: (OHLCVData | null)[] = [null, null, bar(3, 202)];
        expect(() => trimAlignedPair(primary, aligned, 10)).to.throw(CrossSymbolAlignmentError);
    });

    it('passes when aligned length exactly equals minBars', () => {
        const primary = [bar(1, 100), bar(2, 101)];
        const aligned: (OHLCVData | null)[] = [bar(1, 200), bar(2, 201)];
        const result = trimAlignedPair(primary, aligned, 2);
        expect(result.primaryData).to.have.length(2);
    });

    it('output arrays have equal length', () => {
        const primary = [bar(1, 100), bar(2, 101), bar(3, 102), bar(4, 103), bar(5, 104)];
        const aligned: (OHLCVData | null)[] = [null, null, bar(3, 202), bar(4, 203), bar(5, 204)];
        const result = trimAlignedPair(primary, aligned, 1);
        expect(result.primaryData.length).to.equal(result.secondaryData.length);
    });
});

// ============================================================================
// buildRelativeStrength
// ============================================================================

describe('buildRelativeStrength', () => {
    it('computes ratio correctly', () => {
        const result = buildRelativeStrength([100, 200, 150], [50, 100, 75]);
        expect(result).to.deep.equal([2, 2, 2]);
    });

    it('returns NaN for zero secondary close', () => {
        const result = buildRelativeStrength([100], [0]);
        expect(result[0]).to.be.NaN;
    });

    it('handles mismatched lengths by using minimum', () => {
        const result = buildRelativeStrength([100, 200], [50]);
        expect(result).to.have.length(1);
    });
});

describe('buildRollingPairCorrelation', () => {
    it('returns null for first lookback-1 bars', () => {
        const result = buildRollingPairCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 3);
        expect(result[0]).to.be.null;
        expect(result[1]).to.be.null;
        expect(result[2]).to.not.be.null;
    });

    it('returns 1 for perfectly correlated series', () => {
        const primary = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const secondary = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        const result = buildRollingPairCorrelation(primary, secondary, 5);
        // From index 4 onward should be ~1
        for (let i = 4; i < result.length; i++) {
            expect(result[i]).to.be.closeTo(1, 0.001);
        }
    });

    it('returns -1 for perfectly inversely correlated series', () => {
        const primary = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const secondary = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
        const result = buildRollingPairCorrelation(primary, secondary, 5);
        for (let i = 4; i < result.length; i++) {
            expect(result[i]).to.be.closeTo(-1, 0.001);
        }
    });
});
