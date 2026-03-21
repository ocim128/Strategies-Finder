import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Time } from '../lib/strategies/index';
import { supertrend_friction_pinch } from '../lib/strategies/lib/supertrend_friction_pinch';
import { supertrend_distance_zscore } from '../lib/strategies/lib/supertrend_distance_zscore';
import { supertrend_churn_resilience } from '../lib/strategies/lib/supertrend_churn_resilience';
import { volume_profile_poc_median_shift } from '../lib/strategies/lib/volume_profile_poc_median_shift';
import { candle_pattern_persistence_score_median_deviation_streak } from '../lib/strategies/lib/candle-pattern-persistence-score-median-deviation-streak';
import { vwap_zscore_reversion } from '../lib/strategies/lib/vwap_zscore_reversion';
import { adx_slope_pivot_entry } from '../lib/strategies/lib/adx_slope_pivot_entry';
import { macd_histogram_volatility_squeeze } from '../lib/strategies/lib/macd_histogram_volatility_squeeze';
import { entropy_ratio_regime_alignment } from '../lib/strategies/lib/entropy_ratio_regime_alignment';
import { pattern_regime_alignment } from '../lib/strategies/lib/pattern_regime_alignment';

describe('strategy lib prepared execution parity', () => {
    it('keeps prepared heavy-indicator strategies aligned with execute()', () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 180; i++) {
            const base = 100 + i * 0.25 + Math.sin(i / 6) * 4;
            bars.push({
                time: (i + 1) as Time,
                open: base - 0.5,
                high: base + 1.25,
                low: base - 1.25,
                close: base + Math.cos(i / 5) * 0.75,
                volume: 100 + (i % 12) * 8,
            });
        }

        const cases = [
            {
                key: 'volume_profile_poc_median_shift',
                strategy: volume_profile_poc_median_shift,
                params: { vpPeriod: 30, medianLookback: 12, shiftThreshold: 1.2 },
            },
            {
                key: 'supertrend_friction_pinch',
                strategy: supertrend_friction_pinch,
                params: { stPeriod: 10, pinchLookback: 20, rocTarget: 1.5 },
            },
            {
                key: 'supertrend_distance_zscore',
                strategy: supertrend_distance_zscore,
                params: { stPeriod: 10, zscoreLookback: 30, zscoreTrigger: 2.2 },
            },
            {
                key: 'supertrend_churn_resilience',
                strategy: supertrend_churn_resilience,
                params: { stPeriod: 10, stMultiplier: 3, maxCrossings: 2 },
            },
            {
                key: 'candle_pattern_persistence_score_median_deviation_streak',
                strategy: candle_pattern_persistence_score_median_deviation_streak,
                params: { scoreLookback: 6, medianLookback: 18 },
            },
            {
                key: 'vwap_zscore_reversion',
                strategy: vwap_zscore_reversion,
                params: { zscoreLookback: 24, zscoreThreshold: 2.1 },
            },
            {
                key: 'adx_slope_pivot_entry',
                strategy: adx_slope_pivot_entry,
                params: { adxPeriod: 14, pivotBars: 8, adxSlopeLen: 3 },
            },
            {
                key: 'macd_histogram_volatility_squeeze',
                strategy: macd_histogram_volatility_squeeze,
                params: { macdFast: 12, stdDevLookback: 30, squeezeThreshold: 0.05 },
            },
            {
                key: 'entropy_ratio_regime_alignment',
                strategy: entropy_ratio_regime_alignment,
                params: { slowWindow: 28, fastWindow: 999, ratioThreshold: -99 },
            },
            {
                key: 'pattern_regime_alignment',
                strategy: pattern_regime_alignment,
                params: { scoreLookback: 6, medianLookback: 18, slowWindow: 32 },
            },
        ] as const;

        for (const testCase of cases) {
            const strategy = testCase.strategy;
            expect(strategy, `missing strategy ${testCase.key}`).to.not.equal(undefined);
            expect(typeof strategy.prepareFinderData, `${testCase.key} should expose prepareFinderData`).to.equal('function');
            expect(typeof strategy.executePrepared, `${testCase.key} should expose executePrepared`).to.equal('function');

            const prepared = strategy.prepareFinderData!(bars);
            const preparedSignals = strategy.executePrepared!(prepared, testCase.params, bars);
            const directSignals = strategy.execute(bars, testCase.params);

            expect(preparedSignals, `${testCase.key} prepared-path drift`).to.deep.equal(directSignals);
        }
    });
});
