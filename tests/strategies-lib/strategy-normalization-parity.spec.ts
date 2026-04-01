import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Strategy } from '../lib/strategies';
import { adx_skewness_drift } from '../lib/strategies/lib/adx_skewness_drift';
import { bollinger_skewness_ride } from '../lib/strategies/lib/bollinger_skewness_ride';
import { crossing_churn_suppression } from '../lib/strategies/lib/crossing_churn_suppression';
import { cumulative_decay_regime_filter } from '../lib/strategies/lib/cumulative_decay_regime_filter';
import { high_low_midpoint_crossover_momentum } from '../lib/strategies/lib/high-low-midpoint-crossover-momentum';
import { macd_signal_pinch_explosion } from '../lib/strategies/lib/macd_signal_pinch_explosion';
import { momentum_zscore_exhaustion } from '../lib/strategies/lib/momentum_zscore_exhaustion';
import { rsi_volatility_pinch_pop } from '../lib/strategies/lib/rsi_volatility_pinch_pop';
import { supertrend_churn_resilience } from '../lib/strategies/lib/supertrend_churn_resilience';
import { supertrend_distance_zscore } from '../lib/strategies/lib/supertrend_distance_zscore';

function buildBars(length: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < length; i++) {
        const trend = 100 + i * 0.18;
        const wave = Math.sin(i / 5) * 3 + Math.cos(i / 11) * 1.5;
        const close = trend + wave;
        const open = close - Math.sin(i / 3) * 0.8;
        const high = Math.max(open, close) + 1.2 + (i % 3) * 0.1;
        const low = Math.min(open, close) - 1.1 - (i % 2) * 0.1;

        bars.push({
            time: i + 1,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 7) * 50,
        });
    }
    return bars;
}

describe('strategy normalization parity', () => {
    const bars = buildBars(240);
    const cases: Array<{ key: string; strategy: Strategy; rawParams: Record<string, number> }> = [
        {
            key: 'bollinger_skewness_ride',
            strategy: bollinger_skewness_ride,
            rawParams: { bbPeriod: 20.4, bbMult: -2, skewThreshold: -0.4 },
        },
        {
            key: 'crossing_churn_suppression',
            strategy: crossing_churn_suppression,
            rawParams: { maPeriod: 19.6, maxCrossings: -1 },
        },
        {
            key: 'cumulative_decay_regime_filter',
            strategy: cumulative_decay_regime_filter,
            rawParams: { roc_lookback: 0, decay_factor: 1.8, z_thresh: -1.5 },
        },
        {
            key: 'high_low_midpoint_crossover_momentum',
            strategy: high_low_midpoint_crossover_momentum,
            rawParams: { midpointBars: 8.2, crossThreshold: -0.1, minRangePct: 0.1 },
        },
        {
            key: 'macd_signal_pinch_explosion',
            strategy: macd_signal_pinch_explosion,
            rawParams: { macdFast: 40, lookbackMin: 1, rocTrigger: -2 },
        },
        {
            key: 'momentum_zscore_exhaustion',
            strategy: momentum_zscore_exhaustion,
            rawParams: { momPeriod: 0, zscoreLookback: 1, zscoreTrigger: -3 },
        },
        {
            key: 'rsi_volatility_pinch_pop',
            strategy: rsi_volatility_pinch_pop,
            rawParams: { rsiPeriod: 1, pinchLookback: 1, rocTarget: -10 },
        },
        {
            key: 'supertrend_churn_resilience',
            strategy: supertrend_churn_resilience,
            rawParams: { stPeriod: 0, stMultiplier: -3, maxCrossings: -1 },
        },
        {
            key: 'supertrend_distance_zscore',
            strategy: supertrend_distance_zscore,
            rawParams: { stPeriod: 0, zscoreLookback: 1, zscoreTrigger: -2.5 },
        },
    ];

    it('keeps adx_skewness_drift deterministic across repeated runs', () => {
        const params = { adxPeriod: 14, adxThresh: 20, skewThreshold: 0.3 };
        const firstRun = adx_skewness_drift.execute(bars, params);
        const secondRun = adx_skewness_drift.execute(bars, params);

        expect(secondRun).to.deep.equal(firstRun);
    });

    it('exposes normalizeParams and keeps defaults canonical for the affected strategies', () => {
        for (const testCase of cases) {
            expect(typeof testCase.strategy.normalizeParams, `${testCase.key} missing normalizeParams`).to.equal('function');

            const normalizedDefaults = testCase.strategy.normalizeParams!(testCase.strategy.defaultParams);
            expect(normalizedDefaults, `${testCase.key} default params drift`).to.deep.equal(testCase.strategy.defaultParams);
        }
    });

    it('keeps direct execution aligned with normalized parameter values', () => {
        for (const testCase of cases) {
            const normalizedParams = testCase.strategy.normalizeParams!(testCase.rawParams);
            const rawSignals = testCase.strategy.execute(bars, testCase.rawParams);
            const normalizedSignals = testCase.strategy.execute(bars, normalizedParams);

            expect(rawSignals, `${testCase.key} execute() should normalize params internally`).to.deep.equal(normalizedSignals);
        }
    });
});
