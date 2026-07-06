import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { BacktestSettings, OHLCVData, Strategy, Time } from '../lib/types/strategies';
import type { FinderResult } from '../lib/types/finder';
import { buildSelectionResult } from '../lib/finder/endpoint';
import { getFinderMetricValue } from '../lib/finder/finder-engine';
import { getFinderDisplayResult } from '../lib/finder/finder-ui';
import { FinderParamSpace } from '../lib/finder/finder-param-space';
import { calculateSharpeRatioFromEquityCurve } from '../lib/strategies/performance-metrics';
import {
    buildFinderEvaluationData,
    resolveFinderCandidateBacktestSettings,
    shouldUseRustCachedMode,
} from '../lib/finder/finder-runner';
import {
    buildFinderSearchBaseParams,
    mergeFinderRiskParamsIntoBacktestSettings,
    normalizeFinderCandidateParamSets,
    resolveFinderRiskOverrides,
} from '../lib/finder/finder-runner-core';
import { buildFinderResult, generateSignalsForJob } from '../lib/finder/finder-runner-shared';
import { withExitStrategyBaseParams } from '../lib/finder/exit-strategy-param-prefix';

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

describe('Finder candidate parameter normalization', () => {
    it('normalizes strategy params, preserves Finder risk params, and dedupes effective candidates', () => {
        const strategy = {
            defaultParams: {
                entropy_window: 10,
                implosion_threshold: -0.4,
            },
            normalizeParams: (params: Record<string, number>) => ({
                entropy_window: Math.max(3, Math.round(params.entropy_window ?? 10)),
                implosion_threshold: Math.max(-5, Math.min(-0.01, Number(params.implosion_threshold ?? -0.4))),
            }),
        } as any;

        const normalized = normalizeFinderCandidateParamSets(strategy, [
            { entropy_window: -45, implosion_threshold: 1.82, stopLossPercent: 3 },
            { entropy_window: 3, implosion_threshold: -0.01, stopLossPercent: 3 },
            { entropy_window: 3, implosion_threshold: -0.01, stopLossPercent: 4 },
        ]);

        expect(normalized).to.deep.equal([
            { entropy_window: 3, implosion_threshold: -0.01, stopLossPercent: 3 },
            { entropy_window: 3, implosion_threshold: -0.01, stopLossPercent: 4 },
        ]);
    });

    it('normalizes exit-strategy params separately and splits them from Finder results', () => {
        const strategy = {
            defaultParams: { lookback: 10 },
            normalizeParams: (params: Record<string, number>) => ({
                lookback: Math.max(2, Math.round(params.lookback ?? 10)),
            }),
        } as any;
        const exitBaseParams = { lookback: 7, threshold: 0.25 };
        const combined = withExitStrategyBaseParams({ lookback: 2 }, exitBaseParams);

        const normalized = normalizeFinderCandidateParamSets(
            strategy,
            [
                { ...combined, lookback: 2.4, _exit__lookback: 7.8, _exit__threshold: 0.9 },
                { lookback: 2, _exit__lookback: 8, _exit__threshold: 0.9 },
            ],
            {
                normalizeExitParams: (params) => ({
                    lookback: Math.round(params.lookback ?? 7),
                    threshold: Math.max(0, Math.min(1, params.threshold ?? 0)),
                }),
            }
        );
        const finderResult = buildFinderResult({
            key: 'entry',
            name: 'Entry',
            params: normalized[0],
            exitStrategyKey: 'exit',
            result: {
                netProfit: 0,
                netProfitPercent: 0,
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                avgTrade: 0,
                maxDrawdown: 0,
                maxDrawdownPercent: 0,
                profitFactor: 0,
                expectancy: 0,
                sharpeRatio: 0,
                trades: [],
                equityCurve: [],
            },
        });

        expect(normalized).to.deep.equal([
            { lookback: 2, _exit__lookback: 8, _exit__threshold: 0.9 },
        ]);
        expect(finderResult.params).to.deep.equal({ lookback: 2 });
        expect(finderResult.exitStrategyKey).to.equal('exit');
        expect(finderResult.exitStrategyParams).to.deep.equal({ lookback: 8, threshold: 0.9 });
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

    it('adds MFE bootstrap take-profit params to finder search params when mfe_bootstrap mode is active', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'mfe_bootstrap',
            takeProfitPercent: 6,
            takeProfitMfeBootstrapPercentile: 67,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect(baseParams.takeProfitMfeBootstrapPercentile).to.equal(67);
    });

    it('does not add MFE bootstrap take-profit params when take-profit mode is fixed', () => {
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
            takeProfitMfeBootstrapPercentile: 67,
        };

        const baseParams = buildFinderSearchBaseParams(strategy, settings);

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect('takeProfitMfeBootstrapPercentile' in baseParams).to.equal(false);
    });

    it('random mode can vary MFE bootstrap take-profit params within finder bounds', () => {
        const paramSpace = new FinderParamSpace();
        const combos = paramSpace.generateParamSets(
            {
                lookback: 20,
                takeProfitMfeBootstrapPercentile: 60,
            },
            {
                mode: 'random',
                sortPriority: ['netProfit'],
                useAdvancedSort: false,
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

        const percentiles = new Set(combos.map((combo) => combo.takeProfitMfeBootstrapPercentile));

        expect(percentiles.size).to.be.greaterThan(1);
        expect(combos.every((combo) => (combo.takeProfitMfeBootstrapPercentile ?? 0) >= 1 && (combo.takeProfitMfeBootstrapPercentile ?? 100) <= 99)).to.equal(true);
    });

    it('applies mfe_bootstrap finder overrides only to the TS backtest settings', () => {
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'mfe_bootstrap',
            takeProfitPercent: 6,
            takeProfitMfeBootstrapPercentile: 67,
        };
        const rustSettings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 6,
        };

        const resolved = resolveFinderRiskOverrides(settings, rustSettings, {
            takeProfitMfeBootstrapPercentile: 72.4,
        });

        expect(resolved.backtestSettings.takeProfitMfeBootstrapPercentile).to.equal(72.4);
        expect('takeProfitMfeBootstrapPercentile' in resolved.rustBacktestSettings).to.equal(false);
    });

    it('only exposes supported mode-specific take-profit params in finder search params', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const baseParams = buildFinderSearchBaseParams(strategy, {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'mfe_bootstrap',
            takeProfitPercent: 6,
            takeProfitMfeBootstrapPercentile: 73,
        });

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect(baseParams.takeProfitMfeBootstrapPercentile).to.equal(73);
    });

    it('adds information-coefficient TP params to finder search params only when that mode is active', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const baseParams = buildFinderSearchBaseParams(strategy, {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'information_coefficient',
            takeProfitPercent: 6,
            takeProfitAdaptiveLookbackTrades: 25,
            takeProfitAdaptiveIcScale: 0.8,
            takeProfitAdaptiveMinMultiplier: 0.7,
            takeProfitAdaptiveMaxMultiplier: 1.6,
        });

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.takeProfitPercent).to.equal(6);
        expect(baseParams.takeProfitAdaptiveLookbackTrades).to.equal(25);
        expect(baseParams.takeProfitAdaptiveIcScale).to.equal(0.8);
        expect(baseParams.takeProfitAdaptiveMinMultiplier).to.equal(0.7);
        expect(baseParams.takeProfitAdaptiveMaxMultiplier).to.equal(1.6);
        expect('takeProfitAdaptiveGridSteps' in baseParams).to.equal(false);
    });

    it('applies adaptive TP finder overrides only to the TS backtest settings', () => {
        const settings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'regime_calibrated',
            takeProfitPercent: 6,
            takeProfitAdaptiveLookbackTrades: 25,
            takeProfitAdaptiveGridSteps: 7,
            takeProfitAdaptiveRegimeBlend: 0.6,
        };
        const rustSettings: BacktestSettings = {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 6,
        };

        const resolved = resolveFinderRiskOverrides(settings, rustSettings, {
            takeProfitAdaptiveLookbackTrades: 31,
            takeProfitAdaptiveGridSteps: 9,
            takeProfitAdaptiveRegimeBlend: 0.75,
        });

        expect(resolved.backtestSettings.takeProfitAdaptiveLookbackTrades).to.equal(31);
        expect(resolved.backtestSettings.takeProfitAdaptiveGridSteps).to.equal(9);
        expect(resolved.backtestSettings.takeProfitAdaptiveRegimeBlend).to.equal(0.75);
        expect('takeProfitAdaptiveLookbackTrades' in resolved.rustBacktestSettings).to.equal(false);
        expect('takeProfitAdaptiveGridSteps' in resolved.rustBacktestSettings).to.equal(false);
        expect('takeProfitAdaptiveRegimeBlend' in resolved.rustBacktestSettings).to.equal(false);
    });

    it('reapplies mode-specific TP params back into backtest settings when a finder row is applied', () => {
        const baseSettings: BacktestSettings = {
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            takeProfitMode: 'fixed',
            takeProfitMfeBootstrapPercentile: 60,
        };

        const merged = mergeFinderRiskParamsIntoBacktestSettings(
            { ...baseSettings, takeProfitMode: 'mfe_bootstrap' },
            { takeProfitMfeBootstrapPercentile: 73.6 }
        );

        expect(merged.takeProfitMfeBootstrapPercentile).to.equal(73.6);
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

    it('keeps path-dependent exit params fixed unless Finder path-exit randomization is enabled', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const settings: BacktestSettings = {
            pathExitEnabled: true,
            pathExitMode: 'mfe_giveback',
            pathExitMinBars: 3,
            pathExitMinMfePercent: 1.5,
            pathExitGivebackPercent: 40,
        };

        const fixed = buildFinderSearchBaseParams(strategy, settings);
        const randomized = buildFinderSearchBaseParams(strategy, settings, { randomizePathExitParams: true });

        expect('pathExitMinBars' in fixed).to.equal(false);
        expect(randomized.pathExitMinBars).to.equal(3);
        expect(randomized.pathExitMinMfePercent).to.equal(1.5);
        expect(randomized.pathExitGivebackPercent).to.equal(40);
    });

    it('adds only active-mode path-dependent exit params to Finder search params', () => {
        const strategy = {
            defaultParams: {
                lookback: 20,
            },
        } as any;
        const baseParams = buildFinderSearchBaseParams(strategy, {
            pathExitEnabled: true,
            pathExitMode: 'momentum_deceleration',
            pathExitMinBars: 2,
            pathExitLookbackBars: 12,
            pathExitThreshold: 0,
            pathExitGivebackPercent: 40,
        }, { randomizePathExitParams: true });

        expect(baseParams.lookback).to.equal(20);
        expect(baseParams.pathExitMinBars).to.equal(2);
        expect(baseParams.pathExitLookbackBars).to.equal(12);
        expect(baseParams.pathExitThreshold).to.equal(1);
        expect('pathExitGivebackPercent' in baseParams).to.equal(false);
    });

    it('applies path-dependent exit Finder overrides only to TypeScript settings', () => {
        const settings: BacktestSettings = {
            pathExitEnabled: true,
            pathExitMode: 'mfe_giveback',
            pathExitMinBars: 3,
            pathExitMinMfePercent: 1.5,
            pathExitGivebackPercent: 40,
        };
        const rustSettings: BacktestSettings = {};

        const resolved = resolveFinderRiskOverrides(settings, rustSettings, {
            pathExitMinBars: 7,
            pathExitMinMfePercent: 2.25,
            pathExitGivebackPercent: 65,
        }, { randomizePathExitParams: true });

        expect(resolved.backtestSettings.pathExitMinBars).to.equal(7);
        expect(resolved.backtestSettings.pathExitMinMfePercent).to.equal(2.25);
        expect(resolved.backtestSettings.pathExitGivebackPercent).to.equal(65);
        expect('pathExitMinBars' in resolved.rustBacktestSettings).to.equal(false);
    });

    it('random mode can vary path-dependent exit params once they are part of the search params', () => {
        const paramSpace = new FinderParamSpace();
        const combos = paramSpace.generateParamSets(
            {
                lookback: 20,
                pathExitMinBars: 4,
                pathExitGivebackPercent: 40,
            },
            {
                mode: 'random',
                sortPriority: ['netProfit'],
                useAdvancedSort: false,
                multiTimeframeEnabled: false,
                timeframes: [],
                topN: 10,
                steps: 3,
                rangePercent: 50,
                maxRuns: 12,
                tradeFilterEnabled: false,
                minTrades: 0,
                maxTrades: Number.POSITIVE_INFINITY,
                comboEnabled: false,
                randomSeed: 42,
                randomizePathExitParams: true,
            }
        );

        const minBars = new Set(combos.map((combo) => combo.pathExitMinBars));
        const givebacks = new Set(combos.map((combo) => combo.pathExitGivebackPercent));

        expect(minBars.size).to.be.greaterThan(1);
        expect(givebacks.size).to.be.greaterThan(1);
        expect(combos.every((combo) => (combo.pathExitMinBars ?? 0) >= 1)).to.equal(true);
        expect(combos.every((combo) => (combo.pathExitGivebackPercent ?? 0) >= 1 && (combo.pathExitGivebackPercent ?? 101) <= 100)).to.equal(true);
    });

    it('merges sampled path-dependent exit params back into settings when applying Finder results', () => {
        const settings: BacktestSettings & { riskSettingsToggle?: boolean } = {
            riskSettingsToggle: true,
            pathExitEnabled: true,
            pathExitMode: 'triple_barrier_meta',
            pathExitMinBars: 3,
            pathExitThreshold: 2,
            pathExitMinSamples: 30,
            pathExitHorizonBars: 50,
        };

        const merged = mergeFinderRiskParamsIntoBacktestSettings(
            settings,
            {
                pathExitMinBars: 6,
                pathExitThreshold: 4.5,
                pathExitMinSamples: 12,
                pathExitHorizonBars: 25,
            },
            { randomizePathExitParams: true }
        );

        expect(merged.pathExitMinBars).to.equal(6);
        expect(merged.pathExitThreshold).to.equal(4.5);
        expect(merged.pathExitMinSamples).to.equal(12);
        expect(merged.pathExitHorizonBars).to.equal(25);
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

    it('generates Finder signals through Strategy Timeframe just like manual backtests', () => {
        const data: OHLCVData[] = Array.from({ length: 8 }, (_, index) => ({
            time: (1_700_000_000 + index * 900) as Time,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100 + index,
            volume: 1000,
        }));
        const strategy: Strategy = {
            name: 'Signal Every Input Bar',
            description: 'Test strategy',
            defaultParams: {},
            paramLabels: {},
            execute: (input) => input.map((bar, index) => ({
                time: bar.time,
                type: 'buy',
                price: bar.close,
                barIndex: index,
            })),
        };
        const settings: BacktestSettings = {
            strategyTimeframeEnabled: true,
            strategyTimeframeMinutes: 60,
        };

        const signals = generateSignalsForJob({
            id: 1,
            key: 'signal_every_input_bar',
            name: strategy.name,
            params: {},
            backtestSettings: settings,
            rustBacktestSettings: settings,
            strategy,
        }, data, '15m');

        expect(signals).to.have.length(2);
        expect(signals.map((signal) => signal.barIndex)).to.deep.equal([3, 7]);
    });
});
