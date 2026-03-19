import { expect } from 'chai';
import { describe, it } from 'node:test';
import { noise_to_signal_efficiency_breakout } from '../lib/strategies/lib/noise_to_signal_efficiency_breakout';

describe('noise_to_signal_efficiency_breakout', () => {
    it('exposes normalized base params', () => {
        const normalized = noise_to_signal_efficiency_breakout.normalizeParams!({
            erPeriod: 30,
            choppyThreshold: 0.611,
            rocThreshold: -4
        });

        expect(normalized.erPeriod).to.equal(30);
        expect(normalized.choppyThreshold).to.equal(0.611);
        expect(normalized.rocThreshold).to.equal(0);
    });
});
