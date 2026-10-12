import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    formatWalkForwardBaseParamsSummary,
    formatWalkForwardParamValue,
    formatWalkForwardSignedPercent,
    formatWalkForwardWindowParams,
} from '../lib/walk-forward-formatters';

/**
 * Walk Forward display formatting: compact, trailing-zero-trimmed param values
 * and a signed percentage for report rows. Pure and easy to drift.
 */
describe('walk-forward-formatters: formatWalkForwardParamValue', () => {
    it('renders integers without a decimal point', () => {
        expect(formatWalkForwardParamValue(5)).to.equal('5');
        expect(formatWalkForwardParamValue(0)).to.equal('0');
        expect(formatWalkForwardParamValue(-3)).to.equal('-3');
    });

    it('trims trailing zeros on fractional values', () => {
        expect(formatWalkForwardParamValue(5.5)).to.equal('5.5');
        expect(formatWalkForwardParamValue(2.25)).to.equal('2.25');
        expect(formatWalkForwardParamValue(-2.5)).to.equal('-2.5');
    });

    it('caps precision at three decimals', () => {
        expect(formatWalkForwardParamValue(5.1234)).to.equal('5.123');
    });

    it('stringifies non-finite values verbatim', () => {
        expect(formatWalkForwardParamValue(Number.NaN)).to.equal('NaN');
        expect(formatWalkForwardParamValue(Number.POSITIVE_INFINITY)).to.equal('Infinity');
    });
});

describe('walk-forward-formatters: formatWalkForwardSignedPercent', () => {
    it('always shows an explicit sign and two decimals', () => {
        expect(formatWalkForwardSignedPercent(5)).to.equal('+5.00%');
        expect(formatWalkForwardSignedPercent(2.3)).to.equal('+2.30%');
        expect(formatWalkForwardSignedPercent(-5)).to.equal('-5.00%');
        expect(formatWalkForwardSignedPercent(0)).to.equal('+0.00%');
    });

    it('renders a dash for null or non-finite input', () => {
        expect(formatWalkForwardSignedPercent(null)).to.equal('-');
        expect(formatWalkForwardSignedPercent(Number.NaN)).to.equal('-');
    });
});

describe('walk-forward-formatters: param summaries', () => {
    it('renders key:value pairs for a window', () => {
        expect(formatWalkForwardWindowParams({ a: 1, b: 2.5 })).to.equal('a:1, b:2.5');
    });

    it('returns null for a missing snapshot or empty params', () => {
        expect(formatWalkForwardBaseParamsSummary(null)).to.equal(null);
        expect(formatWalkForwardBaseParamsSummary({ strategyKey: 'k', params: {} })).to.equal(null);
    });

    it('renders key:value pairs for base params', () => {
        expect(formatWalkForwardBaseParamsSummary({ strategyKey: 'k', params: { a: 1, b: 2.5 } })).to.equal('a:1, b:2.5');
    });
});
