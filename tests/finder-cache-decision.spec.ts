import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { BacktestSettings } from './lib/types/strategies';
import type { FinderResult } from './lib/types/finder';
import { buildSelectionResult } from './lib/finder/endpoint';
import { getFinderMetricValue } from './lib/finder/finder-engine';
import { getFinderDisplayResult } from './lib/finder/finder-ui';
import { FinderParamSpace } from './lib/finder/finder-param-space';
import { calculateSharpeRatioFromEquityCurve } from './lib/strategies/performance-metrics';
import {
    buildFinderEvaluationData,
    resolveFinderCandidateBacktestSettings,
    shouldUseRustCachedMode,
} from './lib/finder/finder-runner';
import {
    buildFinderSearchBaseParams,
    mergeFinderRiskParamsIntoBacktestSettings,
    resolveFinderRiskOverrides,
} from './lib/finder/finder-runner-core';

describe('Finder adaptive cache mode decision', () => {
    it('enables cache for large dataset (>500k bars)', () => {
        const result = shouldUseRustCachedMode(600_000, 100, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('disables cache for small dataset with low batch count', () => {
        const result = shouldUseRustCachedMode(100_000, 50, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('enables cache for small dataset with high batch count (>=8)', () => {
        // 200 runs / 20 batch size = 10 batches (>= 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 200, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('disables cache when batch count is just below threshold', () => {
        // 140 runs / 20 batch size = 7 batches (< 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 140, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('enables cache when batch count is exactly at threshold', () => {
        // 160 runs / 20 batch size = 8 batches (== 8 threshold)
        const result = shouldUseRustCachedMode(100_000, 160, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('respects custom minBatchesForCache option', () => {
        // With custom threshold of 5, 100 runs / 20 = 5 batches should trigger
        const result = shouldUseRustCachedMode(100_000, 100, 20, { minBatchesForCache: 5 });
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('high_batch_count');
    });

    it('large dataset takes precedence over batch count', () => {
        // Even with low batch count, large dataset should enable cache
        const result = shouldUseRustCachedMode(600_000, 10, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('handles edge case at exactly 500k bars (not large)', () => {
        // Exactly 500k is the threshold, not > 500k
        const result = shouldUseRustCachedMode(500_000, 100, 20);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });

    it('handles edge case just above 500k bars', () => {
        const result = shouldUseRustCachedMode(500_001, 100, 20);
        expect(result.useCache).to.equal(true);
        expect(result.reason).to.equal('large_dataset');
    });

    it('handles zero batch size safely', () => {
        const result = shouldUseRustCachedMode(100_000, 1, 0);
        expect(result.useCache).to.equal(false);
        expect(result.reason).to.equal('none');
    });
});

describe('Finder candidate backtest settings resolution', () => {
    it('uses candidate-specific risk settings for normal finder runs', () => {
        const candidateSettings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 4,
        };

        const resolved = resolveFinderCandidateBacktestSettings(candidateSettings);

        expect(resolved).to.equal(candidateSettings);
        expect(resolved.stopLossPercent).to.equal(2);
        expect(resolved.takeProfitPercent).to.equal(6);
        expect(resolved.riskMaxHoldBars).to.equal(4);
    });

    it('prefers combo primary settings when finder runs in combo mode', () => {
        const candidateSettings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossPercent: 2,
            takeProfitPercent: 6,
        };
        const primarySettings: BacktestSettings = {
            riskMode: 'simple',
            executionModel: 'next_close',
            stopLossPercent: 9,
            takeProfitPercent: 12,
        };

        const resolved = resolveFinderCandidateBacktestSettings(candidateSettings, primarySettings);

        expect(resolved).to.equal(primarySettings);
        expect(resolved.executionModel).to.equal('next_close');
        expect(resolved.stopLossPercent).to.equal(9);
    });
});

describe('Finder ATR risk randomization support', () => {
    it('adds atrPeriod to finder search params for ATR-risk runs without adding takeProfitAtr', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'simple',
            atrPeriod: 21,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            trailingAtr: 0,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.atrPeriod).to.equal(21);
        expect('takeProfitAtr' in baseParams).to.equal(false);
    });

    it('random mode can vary atrPeriod once it is part of the finder search params', () => {
        const paramSpace = new FinderParamSpace();
        const combos = paramSpace.generateParamSets(
            {
                lookback: 20,
                atrPeriod: 14,
            },
            {
                mode: 'random',
                sortPriority: ['netProfit'],
                useAdvancedSort: false,
                robustSeed: 1337,
                multiTimeframeEnabled: false,
                timeframes: [],
                topN: 10,
                steps: 3,
                rangePercent: 35,
                maxRuns: 12,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Number.POSITIVE_INFINITY,
                comboEnabled: false,
                randomSeed: 42,
            }
        );

        const atrPeriods = new Set(combos.map((combo) => combo.atrPeriod));

        expect(atrPeriods.size).to.be.greaterThan(1);
        expect(combos.every((combo) => !('takeProfitAtr' in combo))).to.equal(true);
    });

    it('applies atrPeriod candidate overrides while keeping takeProfitAtr fixed', () => {
        const settings: BacktestSettings = {
            riskMode: 'simple',
            atrPeriod: 14,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            trailingAtr: 0,
        };

        const resolved = resolveFinderRiskOverrides(settings, settings, { atrPeriod: 29 });

        expect(resolved.backtestSettings.atrPeriod).to.equal(29);
        expect(resolved.rustBacktestSettings.atrPeriod).to.equal(29);
        expect(resolved.backtestSettings.takeProfitAtr).to.equal(3);
        expect(resolved.rustBacktestSettings.takeProfitAtr).to.equal(3);
    });

    it('omits Finder risk search params when risk management is frozen', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            atrPeriod: 21,
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 5,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings, { freezeRiskManagement: true });

        expect(baseParams).to.deep.equal({ lookback: 20 });
    });

    it('adds riskMaxHoldBars to finder search params for simple risk runs when enabled', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'simple',
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 6,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.riskMaxHoldBars).to.equal(6);
    });

    it('applies riskMaxHoldBars finder overrides to simple risk runs without mutating Rust overrides', () => {
        const settings: BacktestSettings = {
            riskMode: 'simple',
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 4,
        };
        const rustSettings: BacktestSettings = {
            riskMode: 'simple',
        };

        const resolved = resolveFinderRiskOverrides(settings, rustSettings, { riskMaxHoldBars: 9 });

        expect(resolved.backtestSettings.riskMaxHoldBars).to.equal(9);
        expect('riskMaxHoldBars' in resolved.rustBacktestSettings).to.equal(false);
    });

    it('ignores Finder risk overrides when risk management is frozen', () => {
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 4,
        };
        const rustSettings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
        };

        const resolved = resolveFinderRiskOverrides(
            settings,
            rustSettings,
            { stopLossPercent: 9, takeProfitPercent: 12, riskMaxHoldBars: 11 },
            { freezeRiskManagement: true }
        );

        expect(resolved.backtestSettings).to.equal(settings);
        expect(resolved.rustBacktestSettings).to.equal(rustSettings);
    });

    it('adds shrinkage take-profit params to finder search params when shrinkage mode is active', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'shrinkage',
            takeProfitPercent: 6,
            takeProfitMfeLookbackTrades: 80,
            takeProfitMfePercentile: 67,
            takeProfitShrinkageStrength: 14,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect(baseParams.takeProfitMfeLookbackTrades).to.equal(80);
        expect(baseParams.takeProfitMfePercentile).to.equal(67);
        expect(baseParams.takeProfitShrinkageStrength).to.equal(14);
    });

    it('does not add shrinkage take-profit params when take-profit mode is fixed', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'fixed',
            takeProfitPercent: 6,
            takeProfitMfeLookbackTrades: 80,
            takeProfitMfePercentile: 67,
            takeProfitShrinkageStrength: 14,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect('takeProfitMfeLookbackTrades' in baseParams).to.equal(false);
        expect('takeProfitMfePercentile' in baseParams).to.equal(false);
        expect('takeProfitShrinkageStrength' in baseParams).to.equal(false);
    });

    it('random mode can vary shrinkage take-profit params once they are part of the finder search params', () => {
        const paramSpace = new FinderParamSpace();
        const combos = paramSpace.generateParamSets(
            {
                lookback: 20,
                takeProfitMfeLookbackTrades: 100,
                takeProfitMfePercentile: 60,
                takeProfitShrinkageStrength: 20,
            },
            {
                mode: 'random',
                sortPriority: ['netProfit'],
                useAdvancedSort: false,
                robustSeed: 1337,
                multiTimeframeEnabled: false,
                timeframes: [],
                topN: 10,
                steps: 3,
                rangePercent: 35,
                maxRuns: 12,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Number.POSITIVE_INFINITY,
                comboEnabled: false,
                randomSeed: 42,
            }
        );

        const lookbacks = new Set(combos.map((combo) => combo.takeProfitMfeLookbackTrades));
        const percentiles = new Set(combos.map((combo) => combo.takeProfitMfePercentile));
        const strengths = new Set(combos.map((combo) => combo.takeProfitShrinkageStrength));

        expect(lookbacks.size).to.be.greaterThan(1);
        expect(percentiles.size).to.be.greaterThan(1);
        expect(strengths.size).to.be.greaterThan(1);
        expect(combos.every((combo) => Number.isInteger(combo.takeProfitMfeLookbackTrades))).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitMfePercentile ?? 0) >= 1 && (combo.takeProfitMfePercentile ?? 100) <= 99)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitShrinkageStrength ?? 0) >= 1)).to.equal(true);
    });

    it('applies shrinkage finder overrides only to the TS backtest settings', () => {
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'shrinkage',
            takeProfitPercent: 6,
            takeProfitMfeLookbackTrades: 80,
            takeProfitMfePercentile: 67,
            takeProfitShrinkageStrength: 14,
        };
        const rustSettings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 6,
        };

        const resolved = resolveFinderRiskOverrides(settings, rustSettings, {
            takeProfitMfeLookbackTrades: 135,
            takeProfitMfePercentile: 72.4,
            takeProfitShrinkageStrength: 9.5,
        });

        expect(resolved.backtestSettings.takeProfitMfeLookbackTrades).to.equal(135);
        expect(resolved.backtestSettings.takeProfitMfePercentile).to.equal(72.4);
        expect(resolved.backtestSettings.takeProfitShrinkageStrength).to.equal(9.5);
        expect('takeProfitMfeLookbackTrades' in resolved.rustBacktestSettings).to.equal(false);
        expect('takeProfitMfePercentile' in resolved.rustBacktestSettings).to.equal(false);
        expect('takeProfitShrinkageStrength' in resolved.rustBacktestSettings).to.equal(false);
    });

    it('adds mode-specific take-profit params to finder search params for the new TP modes', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;

        const cases: Array<{
            mode: NonNullable<BacktestSettings['takeProfitMode']>;
            settings: BacktestSettings;
            expected: Record<string, number>;
        }> = [
            {
                mode: 'momentum_gated',
                settings: {
                    riskMode: 'percentage',
                    takeProfitEnabled: true,
                    takeProfitMode: 'momentum_gated',
                    takeProfitPercent: 6,
                    takeProfitMomentumRsiPeriod: 9,
                    takeProfitMomentumRsiPauseLevel: 58,
                    takeProfitMomentumDecayPercentPerBar: 0.35,
                },
                expected: {
                    takeProfitMomentumRsiPeriod: 9,
                    takeProfitMomentumRsiPauseLevel: 58,
                    takeProfitMomentumDecayPercentPerBar: 0.35,
                },
            },
            {
                mode: 'velocity',
                settings: {
                    riskMode: 'percentage',
                    takeProfitEnabled: true,
                    takeProfitMode: 'velocity',
                    takeProfitPercent: 6,
                    takeProfitVelocityFastBars: 3,
                    takeProfitVelocitySlowBars: 18,
                    takeProfitVelocityProgressPercent: 55,
                    takeProfitVelocityExpandMultiplier: 1.8,
                    takeProfitVelocityShrinkMultiplier: 0.7,
                },
                expected: {
                    takeProfitVelocityFastBars: 3,
                    takeProfitVelocitySlowBars: 18,
                    takeProfitVelocityProgressPercent: 55,
                    takeProfitVelocityExpandMultiplier: 1.8,
                    takeProfitVelocityShrinkMultiplier: 0.7,
                },
            },
        ];

        for (const testCase of cases) {
            const baseParams = buildFinderSearchBaseParams(strategy, testCase.settings);
            expect(baseParams.lookback).to.equal(20);
            expect(baseParams.takeProfitPercent).to.equal(6);
            Object.entries(testCase.expected).forEach(([key, value]) => {
                expect(baseParams[key]).to.equal(value, `${testCase.mode}:${key}`);
            });
            expect('takeProfitMfeLookbackTrades' in baseParams).to.equal(false, `${testCase.mode}:unexpected shrinkage key`);
        }
    });

    it('random mode can vary the new take-profit params within finder bounds', () => {
        const paramSpace = new FinderParamSpace();
        const combos = paramSpace.generateParamSets(
            {
                lookback: 20,
                takeProfitMomentumRsiPeriod: 14,
                takeProfitMomentumRsiPauseLevel: 60,
                takeProfitMomentumDecayPercentPerBar: 0.15,
                takeProfitVelocityFastBars: 2,
                takeProfitVelocitySlowBars: 20,
                takeProfitVelocityProgressPercent: 50,
                takeProfitVelocityExpandMultiplier: 1.5,
                takeProfitVelocityShrinkMultiplier: 0.65,
            },
            {
                mode: 'random',
                sortPriority: ['netProfit'],
                useAdvancedSort: false,
                robustSeed: 1337,
                multiTimeframeEnabled: false,
                timeframes: [],
                topN: 10,
                steps: 3,
                rangePercent: 40,
                maxRuns: 20,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Number.POSITIVE_INFINITY,
                comboEnabled: false,
                randomSeed: 42,
            }
        );

        expect(new Set(combos.map((combo) => combo.takeProfitMomentumRsiPeriod)).size).to.be.greaterThan(1);
        expect(new Set(combos.map((combo) => combo.takeProfitVelocityExpandMultiplier)).size).to.be.greaterThan(1);

        expect(combos.every((combo) => (combo.takeProfitMomentumRsiPeriod ?? 0) >= 2)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitMomentumRsiPauseLevel ?? 0) >= 1 && (combo.takeProfitMomentumRsiPauseLevel ?? 100) <= 99)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitMomentumDecayPercentPerBar ?? -1) >= 0)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitVelocityFastBars ?? 0) >= 1)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitVelocitySlowBars ?? 0) >= 1)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitVelocityProgressPercent ?? 0) >= 1 && (combo.takeProfitVelocityProgressPercent ?? 101) <= 100)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitVelocityExpandMultiplier ?? 0) >= 0.1)).to.equal(true);
        expect(combos.every((combo) => (combo.takeProfitVelocityShrinkMultiplier ?? 0) >= 0.1)).to.equal(true);
    });

    it('applies the new TP-mode finder overrides only to the TS backtest settings', () => {
        const cases: Array<{
            mode: NonNullable<BacktestSettings['takeProfitMode']>;
            settings: BacktestSettings;
            params: Record<string, number>;
            expected: Record<string, number>;
        }> = [
            {
                mode: 'momentum_gated',
                settings: {
                    riskMode: 'percentage',
                    takeProfitEnabled: true,
                    takeProfitMode: 'momentum_gated',
                    takeProfitPercent: 6,
                },
                params: {
                    takeProfitMomentumRsiPeriod: 8.7,
                    takeProfitMomentumRsiPauseLevel: 64.2,
                    takeProfitMomentumDecayPercentPerBar: 0.28,
                },
                expected: {
                    takeProfitMomentumRsiPeriod: 9,
                    takeProfitMomentumRsiPauseLevel: 64.2,
                    takeProfitMomentumDecayPercentPerBar: 0.28,
                },
            },
            {
                mode: 'velocity',
                settings: {
                    riskMode: 'percentage',
                    takeProfitEnabled: true,
                    takeProfitMode: 'velocity',
                    takeProfitPercent: 6,
                },
                params: {
                    takeProfitVelocityFastBars: 3.2,
                    takeProfitVelocitySlowBars: 17.6,
                    takeProfitVelocityProgressPercent: 57.5,
                    takeProfitVelocityExpandMultiplier: 1.9,
                    takeProfitVelocityShrinkMultiplier: 0.72,
                },
                expected: {
                    takeProfitVelocityFastBars: 3,
                    takeProfitVelocitySlowBars: 18,
                    takeProfitVelocityProgressPercent: 57.5,
                    takeProfitVelocityExpandMultiplier: 1.9,
                    takeProfitVelocityShrinkMultiplier: 0.72,
                },
            },
        ];

        for (const testCase of cases) {
            const rustSettings: BacktestSettings = {
                riskMode: 'percentage',
                takeProfitEnabled: true,
                takeProfitPercent: 6,
            };
            const resolved = resolveFinderRiskOverrides(testCase.settings, rustSettings, testCase.params);
            Object.entries(testCase.expected).forEach(([key, value]) => {
                expect((resolved.backtestSettings as Record<string, number | undefined>)[key]).to.equal(value, `${testCase.mode}:${key}`);
                expect(key in resolved.rustBacktestSettings).to.equal(false, `${testCase.mode}:${key}:rust`);
            });
        }
    });

    it('reapplies mode-specific TP params back into backtest settings when a finder row is applied', () => {
        const baseSettings: BacktestSettings = {
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            takeProfitMode: 'fixed',
            takeProfitAtrScaledMultiplier: 1.5,
            takeProfitRangeScaledLookback: 20,
            takeProfitRangeScaledFraction: 0.3,
            takeProfitMedianBarLookback: 20,
            takeProfitMedianBarMultiplier: 2,
            takeProfitMfeBootstrapPercentile: 60,
        };

        const cases: Array<{
            mode: NonNullable<BacktestSettings['takeProfitMode']>;
            params: Record<string, number>;
            expected: Partial<BacktestSettings>;
        }> = [
            {
                mode: 'atr_scaled',
                params: { takeProfitAtrScaledMultiplier: 2.4 },
                expected: { takeProfitAtrScaledMultiplier: 2.4 },
            },
            {
                mode: 'range_scaled',
                params: {
                    takeProfitRangeScaledLookback: 37.8,
                    takeProfitRangeScaledFraction: 0.42,
                },
                expected: {
                    takeProfitRangeScaledLookback: 38,
                    takeProfitRangeScaledFraction: 0.42,
                },
            },
            {
                mode: 'median_bar',
                params: {
                    takeProfitMedianBarLookback: 18.2,
                    takeProfitMedianBarMultiplier: 3.1,
                },
                expected: {
                    takeProfitMedianBarLookback: 18,
                    takeProfitMedianBarMultiplier: 3.1,
                },
            },
            {
                mode: 'mfe_bootstrap',
                params: { takeProfitMfeBootstrapPercentile: 73.6 },
                expected: { takeProfitMfeBootstrapPercentile: 73.6 },
            },
        ];

        for (const testCase of cases) {
            const merged = mergeFinderRiskParamsIntoBacktestSettings(
                { ...baseSettings, takeProfitMode: testCase.mode },
                testCase.params
            );

            Object.entries(testCase.expected).forEach(([key, value]) => {
                expect((merged as Record<string, unknown>)[key]).to.equal(value, `${testCase.mode}:${key}`);
            });
        }
    });

    it('does not merge Finder risk params back into settings when risk management is frozen', () => {
        const settings: BacktestSettings & { riskSettingsToggle?: boolean } = {
            riskSettingsToggle: true,
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 4,
        };

        const merged = mergeFinderRiskParamsIntoBacktestSettings(
            settings,
            { stopLossPercent: 9, takeProfitPercent: 12, riskMaxHoldBars: 11 },
            { freezeRiskManagement: true }
        );

        expect(merged).to.not.equal(settings);
        expect(merged.stopLossPercent).to.equal(2);
        expect(merged.takeProfitPercent).to.equal(6);
        expect(merged.riskMaxHoldBars).to.equal(4);
    });
});

describe('Finder selection metrics', () => {
    it('ranks and displays selectionResult metrics instead of raw endpoint-biased results', () => {
        const candidate: FinderResult = {
            key: 'demo',
            name: 'Demo',
            params: {},
            result: {
                trades: [],
                netProfit: 8829,
                netProfitPercent: 88.29,
                winRate: 84.5,
                expectancy: 21.38,
                avgTrade: 21.38,
                profitFactor: 1.83,
                maxDrawdown: 517,
                maxDrawdownPercent: 5.17,
                totalTrades: 413,
                winningTrades: 349,
                losingTrades: 64,
                avgWin: 55.75,
                avgLoss: 166.04,
                sharpeRatio: 0.25,
                equityCurve: [],
            },
            selectionResult: {
                trades: [],
                netProfit: 4285.25,
                netProfitPercent: 42.85,
                winRate: 70,
                expectancy: 39.68,
                avgTrade: 39.68,
                profitFactor: 1.66,
                maxDrawdown: 727,
                maxDrawdownPercent: 7.27,
                totalTrades: 108,
                winningTrades: 76,
                losingTrades: 32,
                avgWin: 88,
                avgLoss: 52,
                sharpeRatio: 0.23,
                equityCurve: [],
            },
            endpointAdjusted: true,
            endpointRemovedTrades: 1,
        };

        expect(getFinderMetricValue(candidate, 'netProfit')).to.equal(4285.25);
        expect(getFinderMetricValue(candidate, 'totalTrades')).to.equal(108);
        expect(getFinderMetricValue(candidate, 'profitFactor')).to.equal(1.66);
        expect(getFinderDisplayResult(candidate).netProfit).to.equal(4285.25);
        expect(getFinderDisplayResult(candidate).sharpeRatio).to.equal(0.23);
    });

    it('recomputes endpoint-adjusted sharpe on an equity-curve basis', () => {
        const initialCapital = 10_000;
        const keptTrades = [
            { id: 1, type: 'long', entryTime: '2024-01-01', entryPrice: 100, exitTime: '2024-01-01', exitPrice: 101, pnl: 100, pnlPercent: 1, size: 1 },
            { id: 2, type: 'long', entryTime: '2024-01-02', entryPrice: 100, exitTime: '2024-01-02', exitPrice: 99.5, pnl: -50, pnlPercent: -0.5, size: 1 },
            { id: 3, type: 'long', entryTime: '2024-01-03', entryPrice: 100, exitTime: '2024-01-03', exitPrice: 101.2, pnl: 120, pnlPercent: 1.2, size: 1 },
            { id: 4, type: 'long', entryTime: '2024-01-04', entryPrice: 100, exitTime: '2024-01-04', exitPrice: 99.7, pnl: -30, pnlPercent: -0.3, size: 1 },
            { id: 5, type: 'long', entryTime: '2024-01-05', entryPrice: 100, exitTime: '2024-01-05', exitPrice: 102, pnl: 200, pnlPercent: 2, size: 1 },
            { id: 6, type: 'long', entryTime: '2024-01-06', entryPrice: 100, exitTime: '2024-01-06', exitPrice: 99.8, pnl: -20, pnlPercent: -0.2, size: 1 },
        ] as const;
        const removedTrade = { id: 7, type: 'long', entryTime: '2024-01-07', entryPrice: 100, exitTime: '2024-01-07', exitPrice: 101, pnl: 80, pnlPercent: 0.8, size: 1 } as const;
        let equity = initialCapital;
        const expectedEquityCurve = keptTrades.map((trade) => {
            equity += trade.pnl;
            return { time: trade.exitTime, value: equity };
        });
        const expectedSharpe = calculateSharpeRatioFromEquityCurve(expectedEquityCurve);

        const adjustment = buildSelectionResult({
            trades: [...keptTrades, removedTrade] as any,
            netProfit: 400,
            netProfitPercent: 4,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 7,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        }, '2024-01-07' as any, initialCapital);

        expect(adjustment.adjusted).to.equal(true);
        expect(adjustment.removedTrades).to.equal(1);
        expect(adjustment.result.totalTrades).to.equal(6);
        expect(adjustment.result.sharpeRatio).to.be.closeTo(expectedSharpe, 1e-12);
    });
});

describe('Finder execution-aware data', () => {
    it('adds the next-open bridge candle for next_open runs so finder matches manual backtests', () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const data = [
            { time: nowSec - 120, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: nowSec - 60, open: 101, high: 102, low: 100, close: 101, volume: 1000 },
            { time: nowSec, open: 105, high: 110, low: 103, close: 108, volume: 1000 },
        ];

        const evaluationData = buildFinderEvaluationData(data as any, '1m', {
            executionModel: 'next_open',
        });

        expect(evaluationData).to.have.length(3);
        expect(evaluationData[2]).to.deep.equal({
            time: nowSec,
            open: 105,
            high: 105,
            low: 105,
            close: 105,
            volume: 0,
        });
    });
});
