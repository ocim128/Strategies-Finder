import { expect } from 'chai';
import { describe, it } from 'node:test';
import { formatDisplayPrice } from '../lib/price-format';

/**
 * Adaptive price formatting: the decimal count scales with magnitude so a
 * $60k asset and a sub-cent altcoin both render readably, and trailing zeros
 * are trimmed. This is a pure display contract worth pinning exactly.
 */

describe('price-format: formatDisplayPrice non-finite and zero inputs', () => {
    it('renders a dash for null, undefined and non-finite values', () => {
        expect(formatDisplayPrice(null)).to.equal('-');
        expect(formatDisplayPrice(undefined)).to.equal('-');
        expect(formatDisplayPrice(Number.NaN)).to.equal('-');
        expect(formatDisplayPrice(Number.POSITIVE_INFINITY)).to.equal('-');
        expect(formatDisplayPrice(Number.NEGATIVE_INFINITY)).to.equal('-');
    });

    it('renders a bare zero', () => {
        expect(formatDisplayPrice(0)).to.equal('0');
    });
});

describe('price-format: formatDisplayPrice magnitude tiers', () => {
    it('uses two decimals at or above 1000', () => {
        expect(formatDisplayPrice(1234.5678)).to.equal('1234.57');
        expect(formatDisplayPrice(1000)).to.equal('1000');
        expect(formatDisplayPrice(60_000.5)).to.equal('60000.5');
    });

    it('uses four decimals between 1 and 1000', () => {
        expect(formatDisplayPrice(12.345678)).to.equal('12.3457');
        expect(formatDisplayPrice(12.34)).to.equal('12.34');
        expect(formatDisplayPrice(1)).to.equal('1');
    });

    it('scales decimals below 1 down to the significant digits', () => {
        expect(formatDisplayPrice(0.5)).to.equal('0.5');
        expect(formatDisplayPrice(0.00123456)).to.equal('0.001235');
        expect(formatDisplayPrice(0.0001234)).to.equal('0.0001234');
        expect(formatDisplayPrice(0.0000001)).to.equal('0.0000001');
    });

    it('preserves the sign for negatives', () => {
        expect(formatDisplayPrice(-1234.5678)).to.equal('-1234.57');
        expect(formatDisplayPrice(-0.5)).to.equal('-0.5');
    });
});
