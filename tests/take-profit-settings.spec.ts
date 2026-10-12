import { expect } from 'chai';
import { describe, it } from 'node:test';
import { resolveTakeProfitMode } from '../lib/take-profit-settings';

/**
 * Take profit is a static percentage target only; the adaptive modes were
 * removed. This resolver must collapse every legacy/unknown value (persisted
 * settings, older saved configs, garbage) onto `fixed` rather than failing.
 */
describe('take-profit-settings: resolveTakeProfitMode', () => {
    it('returns fixed for the current value', () => {
        expect(resolveTakeProfitMode('fixed')).to.equal('fixed');
    });

    it('collapses removed adaptive modes onto fixed', () => {
        for (const legacy of ['adaptive', 'adaptive_atr', 'adaptive_volatility', 'trailing', 'dynamic']) {
            expect(resolveTakeProfitMode(legacy)).to.equal('fixed');
        }
    });

    it('collapses unknown, empty and non-string values onto fixed', () => {
        for (const value of [undefined, null, '', 0, 1, true, false, {}, []]) {
            expect(resolveTakeProfitMode(value)).to.equal('fixed');
        }
    });
});
