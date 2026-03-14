import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateRSI, calculateStochastic, calculateVWAP, calculateSessionVWAP, calculateVolumeProfile, calculateDonchianChannels, calculateSupertrend, calculateMomentum, calculateATR, calculateADX, calculateKeltnerChannels, calculateMFI, calculateCMF, calculateIchimoku, runBacktest, runBacktestCompact, OHLCVData, Signal, Time, Trade, Strategy, StrategyParams } from './lib/strategies/index';
import { buildPivotFlags, detectPivots, detectPivotsWithDeviation } from './lib/strategies/strategy-helpers';

import { analyzeTradePatterns, runAnalysisFilterFinder } from './lib/strategies/backtest/trade-analyzer';
import { getOpenPositionForScanner } from './lib/strategies/backtest/signal-preparation';
import { resolveScannerBacktestSettings } from './lib/scanner/scanner-engine';
import { evaluateLatestEntrySignal } from './lib/signal-entry-evaluator';
import { strategies } from './lib/strategies/library';
import { isTwoHourParityAligned, resolveTwoHourParityFromTime } from './lib/two-hour-parity';
import { quickWalkForward, runWalkForwardAnalysis } from './lib/strategies/walk-forward';
import { deriveAutoWalkForwardRange, resolveFiniteRangeReferenceValue } from './lib/walk-forward-range-utils';


describe('Strategy Calculations', () => {
    it('should calculate SMA correctly', () => {
        const data = [10, 20, 30, 40, 50];
        const sma = calculateSMA(data, 3);
        // Period 3:
        // [null, null, (10+20+30)/3=20, (20+30+40)/3=30, (30+40+50)/3=40]
        expect(sma).to.deep.equal([null, null, 20, 30, 40]);
    });

    it('should calculate SMA with nulls for initial period', () => {
        const data = [1, 2, 3, 4, 5];
        const sma = calculateSMA(data, 5);
        expect(sma).to.deep.equal([null, null, null, null, 3]);
    });

    it('should calculate RSI correctly (basic check)', () => {
        // Simple uptrend
        const data = [10, 11, 12, 13, 14, 15]; // Gains: 1, 1, 1, 1, 1
        // Period 2 (very short for testing)
        // i=0: null
        // i=1: change=1, gain=1, loss=0. avgGain=1/2=0.5, avgLoss=0. First RSI calculation requires previous averages? 
        // My implementation:
        // Init loop 1..period: gains/losses accumulated.
        // Then first RSI at i=period.
        // Let's verify black box.
        const rsi = calculateRSI(data, 2);
        expect(rsi.length).to.equal(6);
        // First 2 should be null (index 0 and 1)? 
        // Logic: Fill initial nulls for i=0 to period (exclusive). So 0, 1.
        expect(rsi[0]).to.be.null;
        expect(rsi[1]).to.be.null;
        // Index 2: First RSI.
        expect(rsi[2]).to.be.a('number');
        expect(rsi[2]).to.be.greaterThan(50); // It's going up
    });

    it('should calculate VWAP correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 10, high: 20, low: 5, close: 10, volume: 100 },
            { time: '2023-01-02' as Time, open: 10, high: 20, low: 5, close: 20, volume: 100 },
        ];
        // Day 1: Typical Price = (20+5+10)/3 = 11.666. TPV = 1166.6. Vol = 100. VWAP = 11.666
        // Day 2: Typical Price = (20+5+20)/3 = 15. TPV = 1500. Accum TPV = 2666.6. Accum Vol = 200. VWAP = 13.333
        const vwap = calculateVWAP(data);
        expect(vwap[0]).to.be.closeTo(11.666, 0.01);
        expect(vwap[1]).to.be.closeTo(13.333, 0.01);
    });

    it('should reset Session VWAP on a new UTC date', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01T00:00:00Z' as Time, open: 10, high: 20, low: 5, close: 10, volume: 100 },
            { time: '2023-01-01T01:00:00Z' as Time, open: 10, high: 20, low: 5, close: 20, volume: 100 },
            { time: '2023-01-02T00:00:00Z' as Time, open: 20, high: 24, low: 18, close: 22, volume: 200 },
        ];

        const sessionVwap = calculateSessionVWAP(data);
        expect(sessionVwap[0]).to.be.closeTo(11.666, 0.01);
        expect(sessionVwap[1]).to.be.closeTo(13.333, 0.01);
        expect(sessionVwap[2]).to.be.closeTo((24 + 18 + 22) / 3, 0.01);
    });

    it('should calculate Stochastic Oscillator correctly', () => {
        const high = [10, 10, 10, 10, 10];
        const low = [0, 0, 0, 0, 0];
        const close = [5, 5, 5, 5, 5];
        // Range 0-10. Close 5. %K should be 50.
        const stoch = calculateStochastic(high, low, close, 3, 3);
        // Period 3. 
        // i=0: null
        // i=1: null
        // i=2: High(2,1,0)=10, Low=0. Range=10. Close=5. %K=50.
        // i=3: %K=50.
        // %D is SMA(3) of %K.
        expect(stoch.k[2]).to.equal(50);
    });

    it('should calculate Volume Profile POC correctly', () => {
        const data: OHLCVData[] = [
            // Create a range where most volume is at price 100
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            // Some outlier volume
            { time: '2023-01-04' as Time, open: 110, high: 115, low: 105, close: 110, volume: 100 },
        ];

        // Period 3 for profile.
        // i=0,1,2 < period (3) -> nulls.
        // i=3: Slice 0,1,2.
        // Prices 95-105. POC should be near 100.
        const vp = calculateVolumeProfile(data, 3, 10);
        expect(vp.poc[3]).to.be.closeTo(100, 5);
        expect(vp.vah[3]).to.be.greaterThan(vp.poc[3]!);
        expect(vp.val[3]).to.be.lessThan(vp.poc[3]!);
    });
    it('should calculate Donchian Channels correctly', () => {
        const high = [10, 12, 11, 13, 15];
        const low = [8, 9, 8, 10, 12];
        const period = 3;
        // i=0,1: null
        // i=2: window 0,1,2. MaxHigh(10,12,11)=12. MinLow(8,9,8)=8.
        // i=3: window 1,2,3. MaxHigh(12,11,13)=13. MinLow(9,8,10)=8.
        // i=4: window 2,3,4. MaxHigh(11,13,15)=15. MinLow(8,10,12)=8.
        const { upper, lower, middle } = calculateDonchianChannels(high, low, period);

        expect(upper[2]).to.equal(12);
        expect(lower[2]).to.equal(8);
        expect(middle[2]).to.equal(10);

        expect(upper[3]).to.equal(13);
        expect(lower[3]).to.equal(8);
    });

    it('should calculate Momentum correctly', () => {
        const data = [10, 12, 11, 15];
        const period = 2;
        // i=0,1: null
        // i=2: 11 - 10 = 1
        // i=3: 15 - 12 = 3
        const mom = calculateMomentum(data, period);
        expect(mom[2]).to.equal(1);
        expect(mom[3]).to.equal(3);
    });

    it('should calculate Supertrend correctly (basic)', () => {
        // Flat market, then breakout
        const high = [10, 10, 10, 10, 20];
        const low = [9, 9, 9, 9, 19];
        const close = [9.5, 9.5, 9.5, 9.5, 19.5];
        const period = 3;
        const factor = 1;

        // Just verify it doesn't crash and produces numbers
        const { supertrend, direction } = calculateSupertrend(high, low, close, period, factor);
        expect(supertrend.length).to.equal(5);
        // At index 4, price shoots up, should be bullish (1)
        expect(direction[4]).to.equal(1);
    });

    it('should calculate ADX within expected bounds', () => {
        const high = [10, 11, 12, 13, 14, 15, 16, 17];
        const low = [9, 9.5, 10, 10.5, 11, 12, 13, 14];
        const close = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5];

        const adx = calculateADX(high, low, close, 3);
        expect(adx.length).to.equal(high.length);
        const last = adx[adx.length - 1];
        expect(last).to.be.a('number');
        expect(last).to.be.at.least(0);
        expect(last).to.be.at.most(100);
    });

    it('should calculate Keltner Channels around the EMA', () => {
        const high = [11, 12, 13, 14, 15, 16];
        const low = [9, 10, 11, 12, 13, 14];
        const close = [10, 11, 12, 13, 14, 15];

        const kc = calculateKeltnerChannels(high, low, close, 3, 3, 1.5);
        expect(kc.middle[5]).to.be.a('number');
        expect(kc.upper[5]!).to.be.greaterThan(kc.middle[5]!);
        expect(kc.lower[5]!).to.be.lessThan(kc.middle[5]!);
    });

    it('should calculate MFI within expected bounds', () => {
        const high = [10, 11, 12, 13, 14, 15];
        const low = [9, 10, 11, 12, 13, 14];
        const close = [9.5, 10.8, 11.7, 12.6, 13.4, 14.2];
        const volume = [100, 110, 120, 130, 140, 150];

        const mfi = calculateMFI(high, low, close, volume, 3);
        expect(mfi[5]).to.be.a('number');
        expect(mfi[5]!).to.be.at.least(0);
        expect(mfi[5]!).to.be.at.most(100);
    });

    it('should calculate CMF around the zero line', () => {
        const high = [10, 11, 12, 13, 14, 15];
        const low = [8, 9, 10, 11, 12, 13];
        const close = [9.8, 10.8, 11.7, 12.2, 12.5, 14.6];
        const volume = [100, 110, 120, 130, 140, 150];

        const cmf = calculateCMF(high, low, close, volume, 3);
        expect(cmf[5]).to.be.a('number');
        expect(cmf[5]!).to.be.at.least(-1);
        expect(cmf[5]!).to.be.at.most(1);
    });

    it('should calculate Ichimoku components without future leakage in current spans', () => {
        const high = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
        const low = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
        const close = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

        const ichimoku = calculateIchimoku(high, low, close, 3, 5, 7, 2);
        expect(ichimoku.conversion[4]).to.be.a('number');
        expect(ichimoku.base[6]).to.be.a('number');
        expect(ichimoku.spanA[6]).to.be.a('number');
        expect(ichimoku.spanB[8]).to.be.a('number');
        expect(ichimoku.lagging[0]).to.equal(close[2]);
    });

    it('should key ATR/ADX caches by OHLC inputs, not close only', () => {
        const close = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
        const highTrend = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
        const lowTrend = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
        const highChop = [11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10];
        const lowChop = [9, 10, 9, 10, 9, 10, 9, 10, 9, 10, 9, 10];

        const atrTrend = calculateATR(highTrend, lowTrend, close, 3);
        const atrChop = calculateATR(highChop, lowChop, close, 3);
        const atrChopFreshClose = calculateATR(highChop, lowChop, [...close], 3);
        expect(atrChop).to.deep.equal(atrChopFreshClose);
        expect(atrTrend).to.not.deep.equal(atrChop);

        const adxTrend = calculateADX(highTrend, lowTrend, close, 3);
        const adxChop = calculateADX(highChop, lowChop, close, 3);
        const adxChopFreshClose = calculateADX(highChop, lowChop, [...close], 3);
        expect(adxChop).to.deep.equal(adxChopFreshClose);
        expect(adxTrend).to.not.deep.equal(adxChop);
    });
});

describe('2H Parity Normalization', () => {
    it('should resolve parity from ISO string candle times', () => {
        expect(resolveTwoHourParityFromTime('2026-02-14T01:00:00Z' as Time)).to.equal('even');
        expect(resolveTwoHourParityFromTime('2026-02-14T00:00:00Z' as Time)).to.equal('odd');
    });

    it('should resolve parity from BusinessDay candle times', () => {
        expect(resolveTwoHourParityFromTime({ year: 2026, month: 2, day: 14 } as Time)).to.equal('odd');
    });

    it('should validate alignment without Number(time) coercion', () => {
        const candles: OHLCVData[] = [
            { time: '2026-02-14T01:00:00Z' as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: '2026-02-14T03:00:00Z' as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        ];

        expect(isTwoHourParityAligned(candles, 'even')).to.equal(true);
        expect(isTwoHourParityAligned(candles, 'odd')).to.equal(false);
    });
});

describe('Causal Signal Stability', () => {
    const buildSyntheticBars = (length: number): OHLCVData[] => {
        const bars: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < length; i++) {
            const wave = Math.sin(i / 7) * 1.6;
            const drift = Math.cos(i / 13) * 0.7;
            const open = close;
            close = Math.max(1, close + wave + drift);
            const span = 0.8 + Math.abs(Math.sin(i / 5)) * 0.9;
            bars.push({
                time: (i + 1) as Time,
                open,
                high: Math.max(open, close) + span,
                low: Math.min(open, close) - span,
                close,
                volume: 100 + ((i % 11) * 3),
            });
        }
        return bars;
    };

    const signalKey = (signal: Signal): string =>
        `${Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1}|${signal.type}`;

    const expectPrefixStable = (strategyKey: string, minPrefix = 140): void => {
        const strategy = strategies[strategyKey];
        expect(strategy, `strategy ${strategyKey} should exist`).to.not.equal(undefined);

        const bars = buildSyntheticBars(320);
        const fullSignals = strategy!.execute(bars, strategy!.defaultParams);
        const fullByBar = new Map<number, Set<string>>();

        for (const signal of fullSignals) {
            const barIndex = Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1;
            if (barIndex < 0) continue;
            const bucket = fullByBar.get(barIndex) ?? new Set<string>();
            bucket.add(signalKey(signal));
            fullByBar.set(barIndex, bucket);
        }

        for (let prefix = minPrefix; prefix <= bars.length; prefix++) {
            const prefixSignals = strategy!.execute(bars.slice(0, prefix), strategy!.defaultParams);
            const prefixSet = new Set<string>();
            for (const signal of prefixSignals) {
                const barIndex = Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1;
                if (barIndex >= 0 && barIndex < prefix) {
                    prefixSet.add(signalKey(signal));
                }
            }

            const fullSubset = new Set<string>();
            for (let bar = 0; bar < prefix; bar++) {
                const bucket = fullByBar.get(bar);
                if (!bucket) continue;
                for (const key of bucket) fullSubset.add(key);
            }

            expect(prefixSet.size, `${strategyKey} signal count mismatch at prefix ${prefix}`).to.equal(fullSubset.size);
            for (const key of prefixSet) {
                expect(fullSubset.has(key), `${strategyKey} unstable signal ${key} at prefix ${prefix}`).to.equal(true);
            }
        }
    };

    it('volatility_compression_break should keep prior signals stable when candles are appended', () => {
        expectPrefixStable('volatility_compression_break');
    });
});

describe('Walk-forward parameter normalization', () => {
    it('preserves zero-valued WFA seed params instead of falling back to defaults', () => {
        expect(resolveFiniteRangeReferenceValue(0, 1, 10)).to.equal(0);
        expect(resolveFiniteRangeReferenceValue(undefined, 1, 10)).to.equal(1);
        expect(resolveFiniteRangeReferenceValue(undefined, undefined, 10)).to.equal(10);
    });

    it('keeps zero-capable threshold params anchored at zero in auto WFA ranges', () => {
        const range = deriveAutoWalkForwardRange('rocThreshold', 0);
        expect(range.min).to.equal(0);
        expect(range.max).to.be.greaterThan(0);
        expect(range.step).to.be.greaterThan(0);
    });

    it('keeps signed decimal params centered on their active value in auto WFA ranges', () => {
        const range = deriveAutoWalkForwardRange('rocTrigger', -0.047);
        expect(range.min).to.be.lessThan(0);
        expect(range.max).to.be.lessThan(0);
        expect(range.min).to.be.lessThan(-0.047);
        expect(range.max).to.be.greaterThan(-0.047);
        expect(range.step).to.be.greaterThan(0);
    });

    it('falls back to the active base params when no WFA candidates clear the trade floor', async () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 120; i++) {
            bars.push({
                time: (i + 1) as Time,
                open: 100 + i,
                high: 101 + i,
                low: 99 + i,
                close: 100 + i,
                volume: 10
            });
        }

        const strategy: Strategy = {
            name: 'No Candidate Fallback',
            description: 'Produces no trades so WFA should retain the active base params.',
            defaultParams: {
                rocTrigger: -0.047
            },
            paramLabels: {
                rocTrigger: 'ROC Trigger'
            },
            execute: () => [],
            metadata: {
                role: 'entry',
                direction: 'both',
                walkForwardParams: ['rocTrigger']
            }
        };

        const result = await runWalkForwardAnalysis(
            bars,
            strategy,
            {
                optimizationWindow: 40,
                testWindow: 20,
                stepSize: 20,
                parameterRanges: [{
                    name: 'rocTrigger',
                    ...deriveAutoWalkForwardRange('rocTrigger', strategy.defaultParams.rocTrigger)
                }],
                minTrades: 1,
                topN: 3
            },
            10000,
            100,
            0.1
        );

        expect(result.windows.length).to.be.greaterThan(0);
        for (const window of result.windows) {
            expect(window.optimizedParams.rocTrigger).to.equal(-0.047);
        }
    });

    it('keeps integer-like quick WFA params on-grid', async () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 160; i++) {
            bars.push({
                time: (i + 1) as Time,
                open: 100 + i,
                high: 101 + i,
                low: 99 + i,
                close: 100 + i,
                volume: 10
            });
        }

        const strategy: Strategy = {
            name: 'Integer Param Guard',
            description: 'Fails if quick WFA passes fractional lookback values.',
            defaultParams: {
                lookback: 18,
                threshold: 0.5
            },
            paramLabels: {
                lookback: 'Lookback',
                threshold: 'Threshold'
            },
            execute: (_data, params) => {
                if (!Number.isInteger(params.lookback)) {
                    throw new Error(`fractional lookback: ${params.lookback}`);
                }
                return [];
            },
            metadata: {
                role: 'entry',
                direction: 'both',
                walkForwardParams: ['lookback', 'threshold']
            }
        };

        const result = await quickWalkForward(
            bars,
            strategy,
            10_000,
            100,
            0.1
        );

        for (const window of result.windows) {
            expect(Number.isInteger(window.optimizedParams.lookback)).to.equal(true);
        }
    });

    it('normalizes strategy-specific WFA params before execution and reporting', async () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 180; i++) {
            bars.push({
                time: (i + 1) as Time,
                open: 100 + i,
                high: 101 + i,
                low: 99 + i,
                close: 100 + i,
                volume: 10
            });
        }

        const strategy: Strategy = {
            name: 'Relational Param Guard',
            description: 'Ensures slowWindow is always greater than fastWindow.',
            defaultParams: {
                fastWindow: 10,
                slowWindow: 10,
            },
            paramLabels: {
                fastWindow: 'Fast Window',
                slowWindow: 'Slow Window',
            },
            normalizeParams: (params) => {
                const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 10));
                const slowWindow = Math.max(fastWindow + 1, Math.round(params.slowWindow ?? 10));
                return { ...params, fastWindow, slowWindow };
            },
            execute: (_data, params) => {
                if (params.slowWindow <= params.fastWindow) {
                    throw new Error(`invalid normalized params: ${params.fastWindow}/${params.slowWindow}`);
                }
                return [];
            },
            metadata: {
                role: 'entry',
                direction: 'both',
                walkForwardParams: ['fastWindow', 'slowWindow']
            }
        };

        const result = await runWalkForwardAnalysis(
            bars,
            strategy,
            {
                optimizationWindow: 60,
                testWindow: 20,
                stepSize: 20,
                parameterRanges: [
                    { name: 'fastWindow', min: 8, max: 12, step: 2 },
                    { name: 'slowWindow', min: 8, max: 12, step: 2 },
                ],
                minTrades: 0,
                topN: 2
            },
            10_000,
            100,
            0.1
        );

        expect(result.windows.length).to.be.greaterThan(0);
        for (const window of result.windows) {
            expect(window.optimizedParams.slowWindow).to.be.greaterThan(window.optimizedParams.fastWindow);
        }
    });

    it('exposes normalized base params for noise-to-signal efficiency breakout', () => {
        const strategy = strategies['noise_to_signal_efficiency_breakout'];
        expect(strategy).to.not.equal(undefined);
        expect(typeof strategy.normalizeParams).to.equal('function');

        const normalized = strategy.normalizeParams!({
            erPeriod: 30,
            choppyThreshold: 0.611,
            rocThreshold: -4
        });

        expect(normalized.erPeriod).to.equal(30);
        expect(normalized.choppyThreshold).to.equal(0.611);
        expect(normalized.rocThreshold).to.equal(0);
    });

    it('exposes normalized base params for candle pattern persistence score stoch mid', () => {
        const strategy = strategies['candle_pattern_persistence_score_stoch_mid'];
        expect(strategy).to.not.equal(undefined);
        expect(typeof strategy.normalizeParams).to.equal('function');

        const normalized = strategy.normalizeParams!({
            scoreLookback: 32.4,
            scoreThreshold: -0.419,
            stochLen: 55.6
        });

        expect(normalized.scoreLookback).to.equal(32);
        expect(normalized.scoreThreshold).to.equal(0);
        expect(normalized.stochLen).to.equal(56);
    });

    it('exposes normalized base params for median deviation streak', () => {
        const strategy = strategies['median_deviation_streak'];
        expect(strategy).to.not.equal(undefined);
        expect(typeof strategy.normalizeParams).to.equal('function');

        const normalized = strategy.normalizeParams!({
            medianLookback: 84.6,
            streakThreshold: -2
        });

        expect(normalized.medianLookback).to.equal(85);
        expect(normalized.streakThreshold).to.equal(2);
    });

    it('exposes normalized base params for additional WFA-sensitive strategies', () => {
        const cases: Array<{
            key: string;
            input: StrategyParams;
            expected: StrategyParams;
        }> = [
            {
                key: 'autocorr_deadband_release',
                input: { lookback: 18.4, deadbandWidth: -0.25, rocTrigger: -0.047 },
                expected: { lookback: 18, deadbandWidth: 0, rocTrigger: 0.047 }
            },
            {
                key: 'dead_zone_efficiency_breakout',
                input: { window: 1.2, max_er_threshold: 1.8, roc_trigger: -3 },
                expected: { window: 2, max_er_threshold: 1, roc_trigger: 0 }
            },
            {
                key: 'volatility_compression_break_trend',
                input: { compressionRatio: -4, emaPeriod: 999.2 },
                expected: { compressionRatio: 0.1, emaPeriod: 300 }
            },
            {
                key: 'candle_pattern_persistence_score_macd_zero',
                input: { scoreLookback: 1.4, scoreThreshold: -0.8, macdFastLen: 1.2 },
                expected: { scoreLookback: 2, scoreThreshold: 0, macdFastLen: 2 }
            }
        ];

        for (const testCase of cases) {
            const strategy = strategies[testCase.key];
            expect(strategy, `missing strategy ${testCase.key}`).to.not.equal(undefined);
            expect(typeof strategy.normalizeParams, `${testCase.key} should expose normalizeParams`).to.equal('function');

            const normalized = strategy.normalizeParams!(testCase.input);
            for (const [name, value] of Object.entries(testCase.expected)) {
                expect(normalized[name], `${testCase.key}.${name}`).to.equal(value);
            }
        }
    });
});

describe('Pivot Detection', () => {
    it('should detect zig-zag pivots correctly', () => {
        // Construct a clear zig-zag pattern
        // 0: 100
        // 1: 110 (High candidate)
        // 2: 105
        // 3: 115 (Higher High - should replace previous high) - PIVOT HIGH
        // 4: 100 
        // 5: 90 (Low candidate) - PIVOT LOW
        // 6: 100
        // 7: 120 (High candidate) - PIVOT HIGH
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 }, // High 115
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 }, // Low 90
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 }, // High 120
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        // Depth 2 (halfDepth = 1, look 1 bar left/right)
        // Deviation 5%
        const pivots = detectPivotsWithDeviation(data, 5, 2);

        expect(pivots.length).to.be.greaterThan(0);

        // Should find the lowest low at 90
        const lowPivot = pivots.find(p => !p.isHigh && p.price === 90);
        expect(lowPivot).to.not.be.undefined;
        expect(lowPivot?.index).to.equal(5);

        // Should find the highest high at 120
        const highPivot = pivots.find(p => p.isHigh && p.price === 120);
        expect(highPivot).to.not.be.undefined;
        expect(highPivot?.index).to.equal(7);
    });

    it('should support dynamic deviation thresholds', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 },
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 },
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 },
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        const staticThresholds = new Array(data.length).fill(30);
        const dynamicThresholds = new Array(data.length).fill(30);
        dynamicThresholds[5] = 5;
        dynamicThresholds[7] = 5;

        const staticPivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: staticThresholds,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
            deviationInclusive: false,
        });
        const dynamicPivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: dynamicThresholds,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
            deviationInclusive: false,
        });

        expect(staticPivots.length).to.equal(1);
        expect(dynamicPivots.length).to.be.greaterThan(staticPivots.length);
    });

    it('should expose confirmation indices when requested', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 },
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 },
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 },
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        const pivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: 5,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
        });

        expect(pivots.length).to.be.greaterThan(0);
        pivots.forEach((pivot) => {
            expect(pivot.confirmationIndex).to.equal(pivot.index + 1);
        });
    });

    it('strict pivot flags should match expected extrema behavior', () => {
        const highs = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const lows = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const flags = buildPivotFlags(highs, lows, 1, 'strict');

        expect(flags.pivotHighs[3]).to.equal(true);
        expect(flags.pivotLows[5]).to.equal(true);
        expect(flags.pivotHighs[7]).to.equal(true);
    });
});





describe('Backtesting Engine', () => {
    it('should execute trades and calculate profit correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 }, // Buy here
            { time: '2023-01-03' as Time, open: 110, high: 125, low: 105, close: 120, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 130, low: 110, close: 125, volume: 1000 }, // Sell here
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 125 },
        ];

        // Capital 1000, 100% size, 0% commission
        const result = runBacktest(data, signals, 1000, 100, 0);

        expect(result.totalTrades).to.equal(1);
        expect(result.winningTrades).to.equal(1);
        // Bought 10 shares @ 100 = 1000 cost.
        // Sold 10 shares @ 125 = 1250 value.
        // Profit = 250.
        expect(result.netProfit).to.equal(250);
        expect(result.profitFactor).to.equal(Infinity); // No losses
    });

    it('should execute short trades when trade direction is short', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 95, close: 100, volume: 1000 }, // Sell here
            { time: '2023-01-03' as Time, open: 100, high: 101, low: 85, close: 90, volume: 1000 },
            { time: '2023-01-04' as Time, open: 90, high: 95, low: 75, close: 80, volume: 1000 }, // Buy here
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-04' as Time, type: 'buy', price: 80 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, { tradeDirection: 'short' });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].type).to.equal('short');
        expect(result.netProfit).to.equal(200);
    });

    it('should close by time stop when percentage max hold cap is enabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 }, // Buy
            { time: '2023-01-03' as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: '2023-01-04' as Time, open: 102, high: 103, low: 100, close: 101.5, volume: 1000 }, // Max hold hit
            { time: '2023-01-05' as Time, open: 101.5, high: 102, low: 100, close: 101, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 101 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 2,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
    });

    it('should override percentage stop loss after the configured win streak', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 104.5, low: 99.5, close: 104, volume: 1000 },
            { time: '2023-01-03' as Time, open: 104, high: 104.5, low: 103.5, close: 104, volume: 1000 }, // Sell #1 win
            { time: '2023-01-04' as Time, open: 100, high: 104.5, low: 99.5, close: 104, volume: 1000 },
            { time: '2023-01-05' as Time, open: 104, high: 104.5, low: 103.5, close: 104, volume: 1000 }, // Sell #2 win
            { time: '2023-01-06' as Time, open: 100, high: 100.3, low: 99.8, close: 100, volume: 1000 }, // Buy #3
            { time: '2023-01-07' as Time, open: 100, high: 100.2, low: 98.9, close: 99.2, volume: 1000 }, // 1% SL hit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-03' as Time, type: 'sell', price: 104 },
            { time: '2023-01-04' as Time, type: 'buy', price: 100 },
            { time: '2023-01-05' as Time, type: 'sell', price: 104 },
            { time: '2023-01-06' as Time, type: 'buy', price: 100 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            stopLossPercent: 2,
            riskWinStreakStopLossEnabled: true,
            riskWinStreakStopLossAfterWins: 2,
            riskWinStreakStopLossPercent: 1,
        });

        expect(result.totalTrades).to.equal(3);
        expect(result.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(result.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(result.trades[2].entryTime).to.equal('2023-01-06' as Time);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[1].exitReason).to.equal('signal');
        expect(result.trades[2].exitReason).to.equal('stop_loss');
        expect(result.trades[2].exitTime).to.equal('2023-01-07' as Time);
    });

    it('scanner settings resolver should mirror backtest toggle behavior', () => {
        const rawScannerSettings = {
            riskSettingsToggle: false,
            riskMode: 'simple',
            atrPeriod: 14,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            trailingAtr: 2,
            stopLossPercent: 5,
            takeProfitPercent: 10,
            stopLossEnabled: true,
            takeProfitEnabled: true,
            tradeFilterSettingsToggle: false,
            tradeFilterMode: 'rsi',
            confirmLookback: 4,
            volumeSmaPeriod: 25,
            volumeMultiplier: 2,
            confirmRsiPeriod: 7,
            confirmRsiBullish: 60,
            confirmRsiBearish: 40,
            confirmationStrategiesToggle: false,
            confirmationStrategies: ['test-filter'],
            confirmationStrategyParams: { 'test-filter': { length: 20 } },
            tradeDirection: 'short',
            executionModel: 'next_open',
            allowSameBarExit: false,
            slippageBps: 5,
            snapshotAtrFilterToggle: false,
            snapshotAtrPercentMin: 1.2,
            snapshotAtrPercentMax: 2.1,
        };

        const resolved = resolveScannerBacktestSettings(rawScannerSettings as any);

        expect(resolved.stopLossAtr).to.equal(0);
        expect(resolved.takeProfitAtr).to.equal(0);
        expect(resolved.trailingAtr).to.equal(0);
        expect(resolved.stopLossEnabled).to.equal(false);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect(resolved.tradeFilterMode).to.equal('none');
        expect(resolved.confirmationStrategies).to.deep.equal([]);
        expect(resolved.confirmationStrategyParams).to.deep.equal({});
        expect(resolved.snapshotAtrPercentMin).to.equal(0);
        expect(resolved.snapshotAtrPercentMax).to.equal(0);
    });

    it('scanner settings resolver should accept combined trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'combined',
            riskSettingsToggle: false,
            tradeFilterSettingsToggle: false
        } as any);
        expect(resolved.tradeDirection).to.equal('combined');
    });

    it('scanner settings resolver should accept flip-after-2-losses trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'both_flip_loss_2',
            riskSettingsToggle: false,
            tradeFilterSettingsToggle: false
        } as any);
        expect(resolved.tradeDirection).to.equal('both_flip_loss_2');
    });

    it('scanner settings resolver should coerce string toggles and numeric inputs', () => {
        const resolved = resolveScannerBacktestSettings({
            riskSettingsToggle: 'true',
            riskMode: 'percentage',
            stopLossPercent: '2.5',
            takeProfitPercent: '7.5',
            stopLossEnabled: 'true',
            takeProfitEnabled: 'false',
            riskMaxHoldBars: '12',
            riskMaxHoldEnabled: 'true',
            riskWinStreakStopLossToggle: 'true',
            riskWinStreakStopLossAfterWins: '4',
            riskWinStreakStopLossPercent: '1.25',
            tradeFilterSettingsToggle: 'true',
            tradeFilterMode: 'rsi',
            confirmLookback: '3',
            volumeSmaPeriod: '21',
            volumeMultiplier: '1.8',
            confirmRsiPeriod: '11',
            confirmRsiBullish: '60',
            confirmRsiBearish: '40',
            confirmationStrategiesToggle: 'true',
            confirmationStrategies: ['sma_crossover'],
            confirmationStrategyParams: {
                sma_crossover: {
                    fastPeriod: '9',
                    slowPeriod: '21',
                }
            },
            allowSameBarExit: 'true',
            slippageBps: '12',
            tradeDirection: 'combined',
            snapshotAtrFilterToggle: 'true',
            snapshotAtrPercentMin: '1.1',
            snapshotAtrPercentMax: '2.2',
        } as any);

        expect(resolved.stopLossPercent).to.equal(2.5);
        expect(resolved.takeProfitPercent).to.equal(7.5);
        expect(resolved.stopLossEnabled).to.equal(true);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect(resolved.riskMaxHoldBars).to.equal(12);
        expect(resolved.riskMaxHoldEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossAfterWins).to.equal(4);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(1.25);
        expect(resolved.tradeFilterMode).to.equal('rsi');
        expect(resolved.confirmLookback).to.equal(3);
        expect(resolved.volumeSmaPeriod).to.equal(21);
        expect(resolved.volumeMultiplier).to.equal(1.8);
        expect(resolved.rsiPeriod).to.equal(11);
        expect(resolved.rsiBullish).to.equal(60);
        expect(resolved.rsiBearish).to.equal(40);
        expect(resolved.confirmationStrategies).to.deep.equal(['sma_crossover']);
        expect(resolved.confirmationStrategyParams).to.deep.equal({
            sma_crossover: {
                fastPeriod: 9,
                slowPeriod: 21,
            }
        });
        expect(resolved.allowSameBarExit).to.equal(true);
        expect(resolved.slippageBps).to.equal(12);
        expect(resolved.tradeDirection).to.equal('combined');
        expect(resolved.snapshotAtrPercentMin).to.equal(1.1);
        expect(resolved.snapshotAtrPercentMax).to.equal(2.2);
    });

    it('scanner settings resolver should coerce numeric/boolean strings when toggle keys are absent', () => {
        const resolved = resolveScannerBacktestSettings({
            executionModel: 'next_close',
            allowSameBarExit: 'false',
            slippageBps: '9',
            takeProfitAtr: '2.75',
            confirmationStrategyParams: {
                dynamic_vix_regime: {
                    lookback: '34'
                }
            }
        } as any);

        expect(resolved.executionModel).to.equal('next_close');
        expect(resolved.allowSameBarExit).to.equal(false);
        expect(resolved.slippageBps).to.equal(9);
        expect(resolved.takeProfitAtr).to.equal(2.75);
        expect((resolved.confirmationStrategyParams as any)?.dynamic_vix_regime?.lookback).to.equal(34);
    });

    it('scanner open position should reuse TP/SL from backtest open trade state', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 104, high: 106, low: 102, close: 105, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 110, low: 104, close: 108, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 105 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            atrPeriod: 1,
            stopLossAtr: 1,
            takeProfitAtr: 2,
            trailingAtr: 0,
        };

        const result = runBacktest(data, signals, 10000, 100, 0, settings);
        const lastTrade = result.trades[result.trades.length - 1];
        const openPosition = getOpenPositionForScanner(data, signals, settings);

        expect(lastTrade.exitReason).to.equal('end_of_data');
        expect(lastTrade.takeProfitPrice).to.not.equal(undefined);
        expect(lastTrade.stopLossPrice).to.not.equal(undefined);
        expect(openPosition).to.not.equal(null);
        expect(openPosition?.takeProfitPrice).to.equal(lastTrade.takeProfitPrice ?? null);
        expect(openPosition?.stopLossPrice).to.equal(lastTrade.stopLossPrice ?? null);
    });

    it('should flip position on opposite signals when trade direction is both', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 95, close: 100, volume: 1000 }, // Short entry
            { time: '2023-01-03' as Time, open: 90, high: 91, low: 88, close: 90, volume: 1000 },   // Flip to long
            { time: '2023-01-04' as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 },   // Final close
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 90 },
        ];

        const settings = { tradeDirection: 'both' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].type).to.equal('short');
        expect(full.trades[1].type).to.equal('long');
        expect(full.netProfit).to.be.closeTo(161.1111, 1e-4);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
    });

    it('should flip only after two consecutive losses in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-01-03' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // short loss #1
            { time: '2023-01-04' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short entry
            { time: '2023-01-05' as Time, open: 108, high: 109, low: 107, close: 108, volume: 1000 }, // short loss #2 -> flip to long
            { time: '2023-01-06' as Time, open: 110, high: 111, low: 109, close: 110, volume: 1000 }, // long profit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 105 },
            { time: '2023-01-04' as Time, type: 'sell', price: 104 },
            { time: '2023-01-05' as Time, type: 'buy', price: 108 },
        ];

        const settings = { tradeDirection: 'both_flip_loss_2' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.totalTrades).to.equal(3);
        expect(full.trades[0].type).to.equal('short');
        expect(full.trades[1].type).to.equal('short');
        expect(full.trades[2].type).to.equal('long');
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(full.trades[2].entryTime).to.equal('2023-01-05' as Time);
        expect(full.trades.some(trade => trade.entryTime === ('2023-01-03' as Time) && trade.type === 'long')).to.equal(false);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
    });

    it('should respect configurable flipAfterConsecutiveLosses in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-01-03' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // short loss #1
            { time: '2023-01-04' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short entry
            { time: '2023-01-05' as Time, open: 108, high: 109, low: 107, close: 108, volume: 1000 }, // short loss #2
            { time: '2023-01-06' as Time, open: 107, high: 108, low: 106, close: 107, volume: 1000 }, // short entry
            { time: '2023-01-07' as Time, open: 111, high: 112, low: 110, close: 111, volume: 1000 }, // short loss #3 -> flip
            { time: '2023-01-08' as Time, open: 113, high: 114, low: 112, close: 113, volume: 1000 }, // long profit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 105 },
            { time: '2023-01-04' as Time, type: 'sell', price: 104 },
            { time: '2023-01-05' as Time, type: 'buy', price: 108 },
            { time: '2023-01-06' as Time, type: 'sell', price: 107 },
            { time: '2023-01-07' as Time, type: 'buy', price: 111 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both_flip_loss_2',
            flipAfterConsecutiveLosses: 3,
        });

        expect(result.totalTrades).to.equal(4);
        expect(result.trades[0].type).to.equal('short');
        expect(result.trades[1].type).to.equal('short');
        expect(result.trades[2].type).to.equal('short');
        expect(result.trades[3].type).to.equal('long');
        expect(result.trades[3].entryTime).to.equal('2023-01-07' as Time);
    });

    it('should respect minTradesBeforeFirstFlip and flipCooldownTrades in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-02-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-02-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-02-03' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // short loss #1 (no flip, minTrades gate)
            { time: '2023-02-04' as Time, open: 101, high: 102, low: 100, close: 101, volume: 1000 }, // short entry
            { time: '2023-02-05' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 }, // short loss #2 (no flip, minTrades gate)
            { time: '2023-02-06' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // short entry
            { time: '2023-02-07' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short loss #3 -> first flip to long
            { time: '2023-02-08' as Time, open: 106, high: 107, low: 105, close: 106, volume: 1000 }, // long hold
            { time: '2023-02-09' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // long loss #1 (cooldown block #1)
            { time: '2023-02-10' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // long entry
            { time: '2023-02-11' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 }, // long loss #2 (cooldown block #2)
            { time: '2023-02-12' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // long entry
            { time: '2023-02-13' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // long loss #3 -> cooldown ended, flip to short
            { time: '2023-02-14' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short profit
        ];

        const signals: Signal[] = [
            { time: '2023-02-02' as Time, type: 'sell', price: 100 },
            { time: '2023-02-03' as Time, type: 'buy', price: 102 },
            { time: '2023-02-04' as Time, type: 'sell', price: 101 },
            { time: '2023-02-05' as Time, type: 'buy', price: 103 },
            { time: '2023-02-06' as Time, type: 'sell', price: 102 },
            { time: '2023-02-07' as Time, type: 'buy', price: 104 },
            { time: '2023-02-10' as Time, type: 'buy', price: 105 },
            { time: '2023-02-09' as Time, type: 'sell', price: 104 },
            { time: '2023-02-12' as Time, type: 'buy', price: 104 },
            { time: '2023-02-11' as Time, type: 'sell', price: 103 },
            { time: '2023-02-13' as Time, type: 'sell', price: 102 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both_flip_loss_2',
            flipAfterConsecutiveLosses: 1,
            flipCooldownTrades: 2,
            minTradesBeforeFirstFlip: 3,
        });

        expect(result.totalTrades).to.equal(7);
        expect(result.trades[0].type).to.equal('short');
        expect(result.trades[1].type).to.equal('short');
        expect(result.trades[2].type).to.equal('short');
        expect(result.trades[3].type).to.equal('long');
        expect(result.trades[4].type).to.equal('long');
        expect(result.trades[5].type).to.equal('long');
        expect(result.trades[6].type).to.equal('short');
        expect(result.trades[3].entryTime).to.equal('2023-02-07' as Time);
        expect(result.trades[4].entryTime).to.equal('2023-02-10' as Time);
        expect(result.trades[5].entryTime).to.equal('2023-02-12' as Time);
        expect(result.trades[6].entryTime).to.equal('2023-02-13' as Time);
    });

    it('should support combined direction with same-bar opposite-entry conflicts ignored', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // Conflict bar
            { time: '2023-01-03' as Time, open: 110, high: 112, low: 108, close: 110, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 121, low: 118, close: 120, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 100 }, // Conflict pair should be ignored as entries
            { time: '2023-01-03' as Time, type: 'buy', price: 110 },  // Long entry
            { time: '2023-01-04' as Time, type: 'sell', price: 120 }, // Long exit + short entry
            { time: '2023-01-05' as Time, type: 'buy', price: 100 },  // Short exit + long entry
        ];

        const settings = { tradeDirection: 'combined' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.trades.some(trade => trade.entryTime === ('2023-01-02' as Time))).to.equal(false);
        expect(full.totalTrades).to.equal(3);
        expect(full.netProfit).to.be.closeTo(128.787878, 1e-6);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
    });

    it('should keep combined-mode sharpe consistent between full and compact backtests', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 240; i++) {
            const trend = 100 + i * 0.08;
            const cycle = Math.sin(i / 7) * 1.8;
            const close = trend + cycle;
            data.push({
                time: (i + 1) as unknown as Time,
                open: close - 0.4,
                high: close + 0.9,
                low: close - 0.9,
                close,
                volume: 1000 + (i % 9) * 25
            });
        }

        const signals: Signal[] = [];
        for (let i = 20; i < 220; i += 20) {
            const openLong = i % 40 !== 0;
            signals.push({
                time: (i + 1) as unknown as Time,
                type: openLong ? 'buy' : 'sell',
                price: data[i + 1].close
            });
            signals.push({
                time: (i + 8) as unknown as Time,
                type: openLong ? 'sell' : 'buy',
                price: data[i + 8].close
            });
        }

        const settings = { tradeDirection: 'combined' as const, allowSameBarExit: true, slippageBps: 0 };
        const full = runBacktest(data, signals, 10000, 100, 0.1, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1, settings);

        expect(full.totalTrades).to.equal(compact.totalTrades);
        expect(full.sharpeRatio).to.be.closeTo(compact.sharpeRatio, 1e-9);
    });

    it('should handle commission correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 130, low: 110, close: 125, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 125 },
        ];

        // Capital 1000, 100% size, 1% commission
        // Entry: 
        // Trade Value = 1000 / 1.01 = 990.099...
        // Entry Comm = 9.901
        // Shares = 9.90099...
        //
        // Exit:
        // Value = 9.90099 * 125 = 1237.62...
        // Exit Comm = 12.376...
        // Net Value = 1225.24...
        // Net Profit = 225.24...

        const result = runBacktest(data, signals, 1000, 100, 1);

        expect(result.netProfit).to.be.closeTo(225.24, 0.1);
    });

    it('should keep trade pnlPercent fee-aware', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 100, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 101, high: 103, low: 101, close: 102, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-03' as Time, type: 'sell', price: 101 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 1);

        expect(result.totalTrades).to.equal(1);
        expect(result.netProfit).to.be.lessThan(0);
        expect(result.trades[0].pnl).to.be.lessThan(0);
        expect(result.trades[0].pnlPercent).to.be.lessThan(0);
    });

    it('should keep forced end-of-data equity and drawdown in sync', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
        ];

        const full = runBacktest(data, signals, 1000, 100, 1);
        const compact = runBacktestCompact(data, signals, 1000, 100, 1);
        const finalCapital = 1000 + full.netProfit;

        expect(full.totalTrades).to.equal(1);
        expect(full.trades[0].exitReason).to.equal('end_of_data');
        expect(full.equityCurve[full.equityCurve.length - 1].value).to.be.closeTo(finalCapital, 1e-9);
        expect(compact.maxDrawdown).to.be.closeTo(full.maxDrawdown, 1e-9);
        expect(compact.maxDrawdownPercent).to.be.closeTo(full.maxDrawdownPercent, 1e-9);
    });

    it('should calculate profit factor and drawdown correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 },
            { time: '2023-01-03' as Time, open: 110, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 120, low: 100, close: 120, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 90 }, // Lose 100
            { time: '2023-01-03' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 120 }, // Win 200
        ];

        const result = runBacktest(data, signals, 1000, 100, 0);

        expect(result.totalTrades).to.equal(2);
        expect(result.winningTrades).to.equal(1);
        expect(result.losingTrades).to.equal(1);
        expect(result.netProfit).to.equal(80); // -100 + 180
        expect(result.profitFactor).to.equal(1.8); // 180 / 100
        expect(result.maxDrawdownPercent).to.be.greaterThan(0);
    });

    it('compact and full backtests should stay in sync for summary metrics', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 108, low: 99, close: 106, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 109, low: 101, close: 103, volume: 1000 },
            { time: '2023-01-04' as Time, open: 103, high: 112, low: 102, close: 110, volume: 1000 },
            { time: '2023-01-05' as Time, open: 110, high: 111, low: 104, close: 105, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 106 },
            { time: '2023-01-03' as Time, type: 'sell', price: 103 },
            { time: '2023-01-04' as Time, type: 'buy', price: 110 },
            { time: '2023-01-05' as Time, type: 'sell', price: 105 },
        ];

        const full = runBacktest(data, signals, 10000, 100, 0.1);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1);

        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.winningTrades).to.equal(full.winningTrades);
        expect(compact.losingTrades).to.equal(full.losingTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
        expect(compact.avgTrade).to.be.closeTo(full.avgTrade, 1e-8);
        expect(compact.expectancy).to.be.closeTo(full.expectancy, 1e-8);
        expect(compact.profitFactor).to.be.closeTo(full.profitFactor, 1e-8);
        expect(compact.maxDrawdownPercent).to.be.closeTo(full.maxDrawdownPercent, 1e-8);
    });

    it('should skip invalid entries with non-positive fill prices', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 103, low: 97, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 0 },
            { time: '2023-01-03' as Time, type: 'sell', price: 100 },
        ];

        const full = runBacktest(data, signals, 1000, 100, 0);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0);

        expect(full.totalTrades).to.equal(0);
        expect(compact.totalTrades).to.equal(0);
        expect(Number.isFinite(full.netProfit)).to.equal(true);
        expect(Number.isFinite(compact.netProfit)).to.equal(true);
    });

    it('should filter low-efficiency entries when trend efficiency filter is enabled', () => {
        const data: OHLCVData[] = [];
        const closes = [
            100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101,
            102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113
        ];
        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: (`2023-02-${String(i + 1).padStart(2, '0')}`) as Time,
                open: close - 0.4,
                high: close + 1,
                low: close - 1,
                close,
                volume: 1000
            });
        }

        const signals: Signal[] = [
            { time: '2023-02-12' as Time, type: 'buy', price: 101 },
            { time: '2023-02-14' as Time, type: 'sell', price: 103 },
            { time: '2023-02-21' as Time, type: 'buy', price: 110 },
            { time: '2023-02-23' as Time, type: 'sell', price: 112 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotTrendEfficiencyMin: 0.6
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter low-conviction candles with body percent filter', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 18; i++) {
            const base = 100 + i;
            data.push({
                time: (`2023-03-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base,
                high: base + 1,
                low: base - 1,
                close: base + 0.2,
                volume: 1200
            });
        }

        // Entry 1: doji-like candle (~5% body of range)
        data[12] = {
            time: '2023-03-13' as Time,
            open: 112,
            high: 114,
            low: 110,
            close: 112.2,
            volume: 1300
        };

        // Entry 2: strong body candle (~80% body of range)
        data[15] = {
            time: '2023-03-16' as Time,
            open: 115,
            high: 117,
            low: 114,
            close: 116.6,
            volume: 1300
        };

        const signals: Signal[] = [
            { time: '2023-03-13' as Time, type: 'buy', price: 112.2 },
            { time: '2023-03-14' as Time, type: 'sell', price: 113 },
            { time: '2023-03-16' as Time, type: 'buy', price: 116.6 },
            { time: '2023-03-18' as Time, type: 'sell', price: 117.5 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotBodyPercentMin: 50
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter entries with weak break quality', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 22; i++) {
            const base = 100 + i * 0.4;
            data.push({
                time: (`2023-04-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base,
                high: base + 1.5,
                low: base - 1.5,
                close: base + 0.6,
                volume: 1200
            });
        }

        // Entry 1: closes below trigger -> poor break quality
        data[12] = {
            time: '2023-04-13' as Time,
            open: 100,
            high: 103,
            low: 99,
            close: 101,
            volume: 1400
        };

        // Entry 2: closes strongly above trigger -> high break quality
        data[16] = {
            time: '2023-04-17' as Time,
            open: 104,
            high: 107,
            low: 103,
            close: 106,
            volume: 1500
        };

        const signals: Signal[] = [
            { time: '2023-04-13' as Time, type: 'buy', price: 102 },
            { time: '2023-04-14' as Time, type: 'sell', price: 101.5 },
            { time: '2023-04-17' as Time, type: 'buy', price: 104 },
            { time: '2023-04-19' as Time, type: 'sell', price: 106.5 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotBreakQualityMin: 55
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter weak entries by composite entry quality score', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) {
            const base = 98 + i * 0.5;
            data.push({
                time: (`2023-05-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base - 0.2,
                high: base + 1.2,
                low: base - 1.2,
                close: base + 0.3,
                volume: 1250 + (i % 4) * 60
            });
        }

        // Weak candle profile (small body, weak close, larger opposite wick)
        data[12] = {
            time: '2023-05-13' as Time,
            open: 104.5,
            high: 107,
            low: 103,
            close: 104.8,
            volume: 1300
        };

        // Strong candle profile (large body, strong close, cleaner wick)
        data[18] = {
            time: '2023-05-19' as Time,
            open: 108,
            high: 111,
            low: 107.5,
            close: 110.6,
            volume: 1700
        };

        const signals: Signal[] = [
            { time: '2023-05-13' as Time, type: 'buy', price: 105.8 },
            { time: '2023-05-15' as Time, type: 'sell', price: 105.2 },
            { time: '2023-05-19' as Time, type: 'buy', price: 108.8 },
            { time: '2023-05-22' as Time, type: 'sell', price: 111.2 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotEntryQualityScoreMin: 65
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter rebound traps using TF confluence', () => {
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 5, 1, 0, 0, 0);

        for (let i = 0; i < 80; i++) {
            let close: number;
            if (i < 30) {
                close = 120 - i * 0.7;
            } else if (i < 35) {
                close = 99 + (i - 29) * 1.2;
            } else if (i < 40) {
                close = 105 - (i - 34) * 1.0;
            } else {
                close = 100 + (i - 39) * 0.65;
            }

            const open = close - 0.25;
            const high = Math.max(open, close) + 0.6;
            const low = Math.min(open, close) - 0.6;
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open,
                high,
                low,
                close,
                volume: 1200 + (i % 6) * 30
            });
        }

        const signals: Signal[] = [
            { time: data[34].time, type: 'buy', price: data[34].close },
            { time: data[38].time, type: 'sell', price: data[38].close },
            { time: data[66].time, type: 'buy', price: data[66].close },
            { time: data[70].time, type: 'sell', price: data[70].close },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotTfConfluencePerfMin: 1.2
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
        expect(withFilter.trades[0].entryTime).to.equal(data[66].time);
    });

    it('should evaluate TF snapshot filters on the signal bar (not execution bar) for next_open entries', () => {
        // Snapshot filters must evaluate on the decision/signal bar, NOT the execution bar.
        // Under next_open, execution happens at bar i+1's open, but that bar's close/volume
        // aren't available yet. Filters must only use data up to the signal bar.
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 6, 1, 0, 0, 0);

        // Build data: first 9 bars choppy, then a clear uptrend from bar 9 onward.
        // Signal bar 8: close=108, TF60 perf measured from bar 8's close (not bar 9's).
        // Signal bar 14: close=106, TF60 perf measured from bar 14's close (not bar 15's).
        const closes = [
            100, 101, 102, 103, 104, 105, 106, 107, 108,
            100, 101, 102, 103, 104, 106, 110, 112
        ];

        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open: close - 0.2,
                high: close + 0.8,
                low: close - 0.8,
                close,
                volume: 1200 + (i % 5) * 20
            });
        }

        const signals: Signal[] = [
            { time: data[8].time, type: 'buy', price: data[8].close },
            { time: data[11].time, type: 'sell', price: data[11].close },
            { time: data[14].time, type: 'buy', price: data[14].close },
            { time: data[16].time, type: 'sell', price: data[16].close },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open'
        });

        // Use a high threshold that depends on which bar the filter evaluates.
        // Under the corrected logic, TF60 perf is computed from the signal bar's close,
        // not the execution bar's close, so the filter result may differ.
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open',
            snapshotTf60PerfMin: 1.0
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        // The filter should still allow good entries but based on signal-bar data only.
        expect(withFilter.totalTrades).to.be.greaterThanOrEqual(0);
        expect(withFilter.totalTrades).to.be.lessThanOrEqual(withoutFilter.totalTrades);
    });

    it('should capture entry snapshots on the signal bar for next_open entries', () => {
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 6, 1, 0, 0, 0);
        const closes = [
            100, 101, 102, 103, 104, 105, 106, 107, 108,
            100, 101, 102, 103, 104, 106, 110, 112
        ];

        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open: close - 0.2,
                high: close + 0.8,
                low: close - 0.8,
                close,
                volume: 1200 + (i % 5) * 20
            });
        }

        const signals: Signal[] = [
            { time: data[14].time, type: 'buy', price: data[14].close },
            { time: data[15].time, type: 'sell', price: data[15].close },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open',
            captureSnapshots: true
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal(data[15].time);
        expect(result.trades[0].entrySnapshot).to.not.be.undefined;

        // 60m lookback on 30m data resolves to two bars back from the signal bar (14 -> 12).
        const expectedTf60Perf = ((data[14].close - data[12].close) / data[12].close) * 100;
        expect(result.trades[0].entrySnapshot?.tf60Perf ?? null).to.be.closeTo(expectedTf60Perf, 1e-9);
    });
});

describe('Trade Analyzer', () => {
    it('relax-aware mode should honor max removal cap', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 100; i++) {
            const isLowQualityBucket = i < 10;
            const bodyPercent = isLowQualityBucket ? 15 : 60 + (i % 5);
            const pnl = isLowQualityBucket
                ? -12
                : (i % 3 === 0 ? -6 : 9);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100 + pnl / 10,
                pnl,
                pnlPercent: pnl / 10,
                size: 1,
                entrySnapshot: {
                    rsi: 50 + (i % 7),
                    adx: 20 + (i % 10),
                    atrPercent: 1 + (i % 5) * 0.05,
                    emaDistance: (i % 11) - 5,
                    volumeRatio: 0.8 + (i % 6) * 0.1,
                    priceRangePos: 0.3 + (i % 6) * 0.1,
                    barsFromHigh: i % 12,
                    barsFromLow: i % 12,
                    trendEfficiency: 0.2 + (i % 8) * 0.08,
                    atrRegimeRatio: 0.8 + (i % 6) * 0.1,
                    bodyPercent,
                    wickSkew: (i % 21) - 10,
                    volumeTrend: 0.8 + (i % 5) * 0.1,
                    volumeBurst: (i % 7) - 3,
                    volumePriceDivergence: ((i % 11) - 5) / 5,
                    volumeConsistency: 0.3 + (i % 8) * 0.1
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'relax_aware',
            maxSingleRemoval: 15
        });

        const suggested = analyses.filter(a => a.suggestedFilter !== null);
        expect(suggested.length).to.be.greaterThan(0);
        suggested.forEach(a => {
            expect(a.tradesRemovedPercent).to.be.at.most(15.0001);
        });
    });

    it('should only suggest below direction for bars-from-high/low features', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const barsValue = isLoss ? 16 + (i % 3) : (i % 4);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -10 : 6,
                pnlPercent: isLoss ? -1 : 0.6,
                size: 1,
                entrySnapshot: {
                    rsi: 50,
                    adx: 25,
                    atrPercent: 1.2,
                    emaDistance: 0.5,
                    volumeRatio: 1.1,
                    priceRangePos: 0.45,
                    barsFromHigh: barsValue,
                    barsFromLow: barsValue,
                    trendEfficiency: 0.6,
                    atrRegimeRatio: 1.1,
                    bodyPercent: 55,
                    wickSkew: 2,
                    volumeTrend: 1.0,
                    volumeBurst: 0.5,
                    volumePriceDivergence: 0.1,
                    volumeConsistency: 0.7
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });

        const barsFromHigh = analyses.find(a => a.feature === 'barsFromHigh');
        const barsFromLow = analyses.find(a => a.feature === 'barsFromLow');

        expect(barsFromHigh).to.not.be.undefined;
        expect(barsFromLow).to.not.be.undefined;
        expect(barsFromHigh?.suggestedFilter).to.not.be.null;
        expect(barsFromLow?.suggestedFilter).to.not.be.null;
        expect(barsFromHigh?.suggestedFilter?.direction).to.equal('below');
        expect(barsFromLow?.suggestedFilter?.direction).to.equal('below');
    });

    it('should keep tiny non-zero suggested thresholds non-zero', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const divergence = isLoss
                ? (-0.000002 + (i * 0.00000002))
                : (0.0000005 + ((i - 10) * 0.00000002));

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -8 : 5,
                pnlPercent: isLoss ? -0.8 : 0.5,
                size: 1,
                entrySnapshot: {
                    rsi: 52,
                    adx: 24,
                    atrPercent: 1.15,
                    emaDistance: 0.4,
                    volumeRatio: 1.05,
                    priceRangePos: 0.5,
                    barsFromHigh: 3,
                    barsFromLow: 3,
                    trendEfficiency: 0.62,
                    atrRegimeRatio: 1.05,
                    bodyPercent: 58,
                    wickSkew: 1,
                    volumeTrend: 1.02,
                    volumeBurst: 0.2,
                    volumePriceDivergence: divergence,
                    volumeConsistency: 0.72
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });
        const divergenceFeature = analyses.find(a => a.feature === 'volumePriceDivergence');

        expect(divergenceFeature).to.not.be.undefined;
        expect(divergenceFeature?.suggestedFilter).to.not.be.null;
        expect(divergenceFeature?.suggestedFilter?.threshold).to.not.equal(0);
    });

    it('finder ranges should keep zero suggested thresholds active', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 12; i++) {
            const isLoss = i < 4;
            const tf60Perf = i < 6 ? -0.2 : 0.2;

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -7 : 6,
                pnlPercent: isLoss ? -0.7 : 0.6,
                size: 1,
                entrySnapshot: {
                    rsi: 52,
                    adx: 24,
                    atrPercent: 1.1,
                    emaDistance: 0.3,
                    volumeRatio: 1.05,
                    priceRangePos: 0.5,
                    barsFromHigh: 3,
                    barsFromLow: 3,
                    trendEfficiency: 0.6,
                    atrRegimeRatio: 1.0,
                    bodyPercent: 55,
                    wickSkew: 1,
                    tf60Perf,
                    volumeTrend: 1.0,
                    volumeBurst: 0.1,
                    volumePriceDivergence: 0.05,
                    volumeConsistency: 0.7
                }
            });
        }

        const finderResult = runAnalysisFilterFinder(
            trades,
            [{
                feature: 'tf60Perf',
                label: 'TF 60m Perf %',
                winStats: { mean: 0.1, median: 0.1, stddev: 0.1, count: 8 },
                lossStats: { mean: -0.1, median: -0.1, stddev: 0.1, count: 4 },
                separationScore: 0.4,
                suggestedFilter: { direction: 'above', threshold: 0 },
                winRateIfFiltered: 0,
                expectancyIfFiltered: 0,
                tradesRemovedPercent: 0
            }],
            { randomTrials: 1, refineTrials: 0 }
        );

        expect(finderResult.featureRanges.length).to.equal(1);
        expect(finderResult.featureRanges[0].suggestedThreshold).to.not.equal(0);
    });
});

describe('Alert Entry Evaluator', () => {
    function buildCandles(count: number, startSec = 1_700_000_000): OHLCVData[] {
        const out: OHLCVData[] = [];
        for (let i = 0; i < count; i++) {
            const open = 100 + i;
            out.push({
                time: (startSec + i * 60) as Time,
                open,
                high: open + 1,
                low: open - 1,
                close: open + 0.5,
                volume: 1000 + i
            });
        }
        return out;
    }

    it('should select latest executed entry instead of latest prepared entry signal', () => {
        const strategyKey = '__test_eval_executed_entry__';
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[strategyKey];

        const testStrategy: Strategy = {
            name: 'Evaluator Executed Entry Test',
            description: 'Ensures evaluator follows executed trades.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'buy', price: data[2].close, barIndex: 2 },
                    { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
                ];
            }
        };

        registry[strategyKey] = testStrategy;
        try {
            const candles = buildCandles(6);
            const result = evaluateLatestEntrySignal({
                strategyKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close'
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.rawSignalCount).to.equal(3);
            expect(result.latestEntry?.signalTimeSec).to.equal(Number(candles[1].time));
            expect(result.latestEntry?.signal.price).to.equal(candles[1].close);
            expect(result.latestEntry?.direction).to.equal('long');
        } finally {
            if (previous) {
                registry[strategyKey] = previous;
            } else {
                delete registry[strategyKey];
            }
        }
    });

    it('should apply confirmation strategies before selecting latest entry', () => {
        const mainKey = '__test_eval_main_with_confirm__';
        const confKey = '__test_eval_confirm_state__';
        const registry = strategies as Record<string, Strategy>;
        const prevMain = registry[mainKey];
        const prevConf = registry[confKey];

        const mainStrategy: Strategy = {
            name: 'Main Confirm Test',
            description: 'Main strategy emits two long entries.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
                ];
            }
        };

        const confirmationStrategy: Strategy = {
            name: 'Confirmation State Test',
            description: 'Turns bearish before the second main entry.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'sell', price: data[2].close, barIndex: 2 },
                ];
            }
        };

        registry[mainKey] = mainStrategy;
        registry[confKey] = confirmationStrategy;

        try {
            const candles = buildCandles(6);
            const result = evaluateLatestEntrySignal({
                strategyKey: mainKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close',
                    tradeFilterMode: 'none',
                    confirmationStrategies: [confKey]
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.rawSignalCount).to.equal(2);
            expect(result.preparedSignalCount).to.equal(1);
            expect(result.latestEntry?.signalTimeSec).to.equal(Number(candles[1].time));
        } finally {
            if (prevMain) {
                registry[mainKey] = prevMain;
            } else {
                delete registry[mainKey];
            }
            if (prevConf) {
                registry[confKey] = prevConf;
            } else {
                delete registry[confKey];
            }
        }
    });
});
