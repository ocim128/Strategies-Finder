import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { BacktestSettings } from './lib/types/strategies';
import type { FinderResult } from './lib/types/finder';
import { getFinderMetricValue } from './lib/finder/finder-engine';
import { FinderParamSpace } from './lib/finder/finder-param-space';
import {
    buildFinderEvaluationData,
    resolveFinderCandidateBacktestSettings,
    shouldUseRustCachedMode,
} from './lib/finder/finder-runner';
import {
    buildFinderSearchBaseParams,
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
