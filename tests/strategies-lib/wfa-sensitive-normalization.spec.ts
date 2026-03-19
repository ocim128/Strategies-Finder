import { expect } from 'chai';
import { describe, it } from 'node:test';
import { StrategyParams } from '../lib/strategies/index';
import { autocorr_deadband_release } from '../lib/strategies/lib/autocorr_deadband_release';
import { dead_zone_efficiency_breakout } from '../lib/strategies/lib/dead_zone_efficiency_breakout';
import { volatility_compression_break_trend } from '../lib/strategies/lib/volatility-compression-break-trend';
import { candle_pattern_persistence_score_macd_zero } from '../lib/strategies/lib/candle-pattern-persistence-score-macd-zero';

describe('strategy lib WFA-sensitive normalization', () => {
    it('exposes normalized base params for additional WFA-sensitive strategies', () => {
        const cases: Array<{
            key: string;
            strategy: { normalizeParams?: (params: StrategyParams) => StrategyParams };
            input: StrategyParams;
            expected: StrategyParams;
        }> = [
            {
                key: 'autocorr_deadband_release',
                strategy: autocorr_deadband_release,
                input: { lookback: 18.4, deadbandWidth: -0.25, rocTrigger: -0.047 },
                expected: { lookback: 18, deadbandWidth: 0, rocTrigger: 0.047 }
            },
            {
                key: 'dead_zone_efficiency_breakout',
                strategy: dead_zone_efficiency_breakout,
                input: { window: 1.2, max_er_threshold: 1.8, roc_trigger: -3 },
                expected: { window: 2, max_er_threshold: 1, roc_trigger: 0 }
            },
            {
                key: 'volatility_compression_break_trend',
                strategy: volatility_compression_break_trend,
                input: { compressionRatio: -4, emaPeriod: 999.2 },
                expected: { compressionRatio: 0.1, emaPeriod: 300 }
            },
            {
                key: 'candle_pattern_persistence_score_macd_zero',
                strategy: candle_pattern_persistence_score_macd_zero,
                input: { scoreLookback: 1.4, scoreThreshold: -0.8, macdFastLen: 1.2 },
                expected: { scoreLookback: 2, scoreThreshold: 0, macdFastLen: 2 }
            }
        ];

        for (const testCase of cases) {
            expect(typeof testCase.strategy.normalizeParams, `${testCase.key} should expose normalizeParams`).to.equal('function');

            const normalized = testCase.strategy.normalizeParams!(testCase.input);
            for (const [name, value] of Object.entries(testCase.expected)) {
                expect(normalized[name], `${testCase.key}.${name}`).to.equal(value);
            }
        }
    });
});
