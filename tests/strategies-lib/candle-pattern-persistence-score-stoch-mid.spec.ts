import { expect } from 'chai';
import { describe, it } from 'node:test';
import { candle_pattern_persistence_score_stoch_mid } from '../lib/strategies/lib/candle-pattern-persistence-score-stoch-mid';

describe('candle_pattern_persistence_score_stoch_mid', () => {
    it('exposes normalized base params', () => {
        const normalized = candle_pattern_persistence_score_stoch_mid.normalizeParams!({
            scoreLookback: 32.4,
            scoreThreshold: -0.419,
            stochLen: 55.6
        });

        expect(normalized.scoreLookback).to.equal(32);
        expect(normalized.scoreThreshold).to.equal(0);
        expect(normalized.stochLen).to.equal(56);
    });
});
