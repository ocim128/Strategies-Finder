import { expect } from 'chai';
import { describe, it } from 'node:test';
import { median_deviation_streak } from '../lib/strategies/lib/median_deviation_streak';

describe('median_deviation_streak', () => {
    it('exposes normalized base params', () => {
        const normalized = median_deviation_streak.normalizeParams!({
            medianLookback: 84.6,
            streakThreshold: -2
        });

        expect(normalized.medianLookback).to.equal(85);
        expect(normalized.streakThreshold).to.equal(2);
    });
});
