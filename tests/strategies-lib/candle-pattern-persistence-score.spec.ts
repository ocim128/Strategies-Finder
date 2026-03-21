import { expect } from 'chai';
import { describe, it } from 'node:test';
import { candle_pattern_persistence_score } from '../lib/strategies/lib/candle-pattern-persistence-score';
import type { OHLCVData } from '../lib/strategies';

describe('candle_pattern_persistence_score', () => {
    it('removes Persistence Threshold and Min Avg Body % from the live param contract', () => {
        expect(Object.keys(candle_pattern_persistence_score.defaultParams)).to.deep.equal([
            'scoreLookback',
        ]);
        expect(Object.keys(candle_pattern_persistence_score.paramLabels)).to.deep.equal([
            'scoreLookback',
        ]);
        expect(candle_pattern_persistence_score.metadata?.walkForwardParams).to.deep.equal([
            'scoreLookback',
        ]);
    });

    it('forces legacy scoreThreshold and minBodyPct inputs to zero', () => {
        const normalized = candle_pattern_persistence_score.normalizeParams!({
            scoreLookback: 1.4,
            scoreThreshold: 0.75,
            minBodyPct: 0.9,
        });

        expect(normalized.scoreLookback).to.equal(2);
        expect(normalized.scoreThreshold).to.equal(0);
        expect(normalized.minBodyPct).to.equal(0);
    });

    it('ignores legacy scoreThreshold and minBodyPct values during execution', () => {
        const data: OHLCVData[] = [
            { time: 1, open: 100, high: 110, low: 90, close: 102, volume: 1_000 },
            { time: 2, open: 102, high: 112, low: 92, close: 104, volume: 1_000 },
            { time: 3, open: 104, high: 114, low: 94, close: 106, volume: 1_000 },
        ];

        const baseSignals = candle_pattern_persistence_score.execute(data, {
            scoreLookback: 2,
        });
        const legacySignals = candle_pattern_persistence_score.execute(data, {
            scoreLookback: 2,
            scoreThreshold: 0.95,
            minBodyPct: 0.95,
        });

        expect(baseSignals.length).to.be.greaterThan(0);
        expect(legacySignals).to.deep.equal(baseSignals);
    });
});
