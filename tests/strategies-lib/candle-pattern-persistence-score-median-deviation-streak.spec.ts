import { expect } from 'chai';
import { describe, it } from 'node:test';
import { candle_pattern_persistence_score_median_deviation_streak } from '../lib/strategies/lib/candle-pattern-persistence-score-median-deviation-streak';

describe('candle_pattern_persistence_score_median_deviation_streak', () => {
    it('exposes normalized base params', () => {
        const normalized = candle_pattern_persistence_score_median_deviation_streak.normalizeParams!({
            scoreLookback: 1.4,
            scoreThreshold: -0.419,
            medianLookback: 84.6,
            streakThreshold: -2
        });

        expect(normalized.scoreLookback).to.equal(2);
        expect(normalized.scoreThreshold).to.equal(0);
        expect(normalized.medianLookback).to.equal(85);
        expect(normalized.streakThreshold).to.equal(2);
    });
});
