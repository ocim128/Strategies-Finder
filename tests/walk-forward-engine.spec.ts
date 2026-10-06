import { expect } from 'chai';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OHLCVData, Signal, Strategy, Time, runBacktest } from '../lib/strategies/index';
import { quickWalkForward, runFixedParamWalkForward, runWalkForwardAnalysis } from '../lib/strategies/walk-forward';
import { registerLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from '../lib/strategies/built-in-catalog';
import { resolveExitStrategyOverrideSignals } from '../lib/backtest-executor';
import { mergeExitStrategySignals } from '../lib/exit-strategy-merge';
import { deriveAutoWalkForwardRange, resolveFiniteRangeReferenceValue } from '../lib/walk-forward-range-utils';

type BarSpec = { close: number; open?: number };

function makeBars(specs: BarSpec[]): OHLCVData[] {
    return specs.map((spec, index) => {
        const open = spec.open ?? spec.close;
        return {
            time: (index + 1) as Time,
            open,
            high: Math.max(open, spec.close),
            low: Math.min(open, spec.close),
            close: spec.close,
            volume: 1000,
        };
    });
}

function makeEntryStrategy(type: 'buy' | 'sell', entryBars: number[]): Strategy {
    return {
        name: 'Spec entry',
        description: 'Enters at fixed bar indexes (0-based).',
        defaultParams: {},
        paramLabels: {},
        execute: (data) => {
            const signals: Signal[] = [];
            for (let i = 0; i < data.length; i++) {
                if (entryBars.includes(i)) {
                    signals.push({ time: data[i]!.time, type, price: data[i]!.close });
                }
            }
            return signals;
        },
        metadata: { role: 'entry', direction: 'both' },
    };
}

function makeExitOverrideStrategy(
    key: string,
    type: 'buy' | 'sell',
    emit: (close: number) => boolean,
): Strategy {
    const strategy: Strategy = {
        name: `Spec exit ${key}`,
        description: 'Close-only exit override fixture.',
        defaultParams: {},
        paramLabels: {},
        execute: (data) => {
            const signals: Signal[] = [];
            for (const bar of data) {
                if (emit(bar.close)) {
                    signals.push({ time: bar.time, type, price: bar.close });
                }
            }
            return signals;
        },
        metadata: { role: 'exit', direction: 'long' },
    };
    registerLoadedBuiltInStrategy(key, strategy);
    return strategy;
}

function withRegisteredExitStrategies<T>(fn: () => Promise<T>): Promise<T> {
    return fn().finally(() => {
        for (const key of Object.keys(registeredExitKeys)) {
            unregisterLoadedBuiltInStrategy(key);
            delete registeredExitKeys[key];
        }
    });
}

const registeredExitKeys: Record<string, Strategy> = {};

function registerTrackedExitStrategy(key: string, strategy: Strategy): Strategy {
    registerLoadedBuiltInStrategy(key, strategy);
    registeredExitKeys[key] = strategy;
    return strategy;
}

/** The shared-executor reference: primary signals + resolved override, merged exactly like runBacktestFast. */
async function executorReferenceResult(
    data: OHLCVData[],
    entryStrategy: Strategy,
    settings: Parameters<typeof resolveExitStrategyOverrideSignals>[0]['settings'],
    capital = 10_000,
) {
    const entrySignals = entryStrategy.execute(data, entryStrategy.defaultParams);
    const resolution = await resolveExitStrategyOverrideSignals({
        data,
        interval: '1m',
        settings,
        blockRange: null,
    });
    const merged = mergeExitStrategySignals(entrySignals, resolution.signals);
    return runBacktest(data, merged, capital, 100, 0, settings);
}

function tradeDigest(result: { trades: { entryTime: Time; exitTime: Time; entryPrice: number; exitPrice: number; pnl: number; exitReason?: string }[] }) {
    return result.trades.map((trade) => [
        trade.entryTime,
        trade.exitTime,
        trade.entryPrice,
        trade.exitPrice,
        trade.pnl,
        trade.exitReason,
    ]);
}

describe('Walk-forward honors the exit strategy override', () => {
    // Bars 0..20 flat at 100 (entry at bar 20), bar 21 rises to 105, bar 22
    // hits 110 (override exit), then the remainder runs to 200 so an
    // unhonored exit keeps the position open until the 200 window-end price.
    const gapData = makeBars([
        ...Array.from({ length: 21 }, () => ({ close: 100 })),
        { close: 105 },
        { close: 110 },
        ...Array.from({ length: 17 }, () => ({ close: 200 })),
    ]);
    const overrideSettings = {
        exitStrategyOverrideEnabled: true,
        disableSignalExits: true,
        exitStrategyKey: 'wfa_spec_exit_sell_above_110',
    };

    it('closes the OOS trade at the override price instead of the window-end price', async () => {
        await withRegisteredExitStrategies(async () => {
            registerTrackedExitStrategy(
                overrideSettings.exitStrategyKey,
                makeExitOverrideStrategy(overrideSettings.exitStrategyKey, 'sell', (close) => close >= 110),
            );
            const entryStrategy = makeEntryStrategy('buy', [20]);

            const result = await runWalkForwardAnalysis(
                gapData,
                entryStrategy,
                {
                    optimizationWindow: 20,
                    testWindow: 20,
                    stepSize: 20,
                    parameterRanges: [],
                    minTrades: 1,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                overrideSettings,
            );

            expect(result.windows.length).to.equal(1);
            expect(result.combinedOOSTrades.totalTrades).to.equal(1);
            expect(result.combinedOOSTrades.netProfit).to.equal(1000);
            expect(result.combinedOOSTrades.trades[0]!.exitPrice).to.equal(110);
            expect(result.combinedOOSTrades.trades[0]!.exitReason).to.equal('signal');
        });
    });

    it('matches the shared executor on the identical OOS window and capital', async () => {
        await withRegisteredExitStrategies(async () => {
            registerTrackedExitStrategy(
                overrideSettings.exitStrategyKey,
                makeExitOverrideStrategy(overrideSettings.exitStrategyKey, 'sell', (close) => close >= 110),
            );
            const entryStrategy = makeEntryStrategy('buy', [20, 38]);
            // A second dip lets the boundary case exist: entry at bar 38,
            // override exit exactly at the last bar of the OOS window.
            const boundaryData = makeBars([
                ...Array.from({ length: 21 }, () => ({ close: 100 })),
                { close: 105 },
                { close: 110 },
                ...Array.from({ length: 15 }, () => ({ close: 200 })),
                { close: 100 },
                { close: 110 },
            ]);

            const result = await runWalkForwardAnalysis(
                boundaryData,
                entryStrategy,
                {
                    optimizationWindow: 20,
                    testWindow: 20,
                    stepSize: 20,
                    parameterRanges: [],
                    minTrades: 1,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                overrideSettings,
            );
            const reference = await executorReferenceResult(boundaryData, entryStrategy, overrideSettings);

            expect(result.combinedOOSTrades.totalTrades).to.equal(2);
            // Trade compounding: the first win grows the capital the second
            // trade sizes from (10000 -> 11000 -> +1100).
            expect(result.combinedOOSTrades.netProfit).to.equal(2100);
            expect(tradeDigest(result.combinedOOSTrades)).to.deep.equal(tradeDigest(reference));
            // The second exit fires on the final bar of the window.
            const lastTrade = result.combinedOOSTrades.trades[1]!;
            expect(lastTrade.exitTime).to.equal(boundaryData[boundaryData.length - 1]!.time);
            expect(lastTrade.exitPrice).to.equal(110);
        });
    });

    it('matches the executor under next_open execution', async () => {
        await withRegisteredExitStrategies(async () => {
            registerTrackedExitStrategy(
                overrideSettings.exitStrategyKey,
                makeExitOverrideStrategy(overrideSettings.exitStrategyKey, 'sell', (close) => close >= 110),
            );
            const entryStrategy = makeEntryStrategy('buy', [20]);
            const nextOpenData = makeBars([
                ...Array.from({ length: 21 }, () => ({ close: 100 })),
                { close: 105, open: 100 },
                { close: 110 },
                { close: 112, open: 112 },
                ...Array.from({ length: 16 }, () => ({ close: 200 })),
            ]);
            const settings = { ...overrideSettings, executionModel: 'next_open' as const };

            const result = await runWalkForwardAnalysis(
                nextOpenData,
                entryStrategy,
                {
                    optimizationWindow: 20,
                    testWindow: 20,
                    stepSize: 20,
                    parameterRanges: [],
                    minTrades: 1,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                settings,
            );
            const reference = await executorReferenceResult(nextOpenData, entryStrategy, settings);

            expect(result.combinedOOSTrades.totalTrades).to.equal(1);
            expect(result.combinedOOSTrades.trades[0]!.entryPrice).to.equal(100);
            expect(result.combinedOOSTrades.trades[0]!.exitPrice).to.equal(112);
            expect(tradeDigest(result.combinedOOSTrades)).to.deep.equal(tradeDigest(reference));
        });
    });

    it('matches the executor for short trades closed by the override', async () => {
        await withRegisteredExitStrategies(async () => {
            const shortExitKey = 'wfa_spec_exit_buy_above_110';
            registerTrackedExitStrategy(
                shortExitKey,
                makeExitOverrideStrategy(shortExitKey, 'buy', (close) => close >= 110),
            );
            const entryStrategy = makeEntryStrategy('sell', [20]);
            const settings = { ...overrideSettings, exitStrategyKey: shortExitKey, tradeDirection: 'short' as const };

            const result = await runWalkForwardAnalysis(
                gapData,
                entryStrategy,
                {
                    optimizationWindow: 20,
                    testWindow: 20,
                    stepSize: 20,
                    parameterRanges: [],
                    minTrades: 1,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                settings,
            );
            const reference = await executorReferenceResult(gapData, entryStrategy, settings);

            expect(result.combinedOOSTrades.totalTrades).to.equal(1);
            expect(result.combinedOOSTrades.netProfit).to.equal(-1000);
            expect(tradeDigest(result.combinedOOSTrades)).to.deep.equal(tradeDigest(reference));
        });
    });

    it('keeps overrides-disabled and zero-signal overrides on the legacy window-end outcome', async () => {
        await withRegisteredExitStrategies(async () => {
            const entryStrategy = makeEntryStrategy('buy', [20]);
            const baseConfig = {
                optimizationWindow: 20,
                testWindow: 20,
                stepSize: 20,
                parameterRanges: [] as { name: string; min: number; max: number; step: number }[],
                minTrades: 1,
                chartInterval: '1m',
            };

            const disabled = await runWalkForwardAnalysis(
                gapData,
                entryStrategy,
                baseConfig,
                10_000,
                100,
                0,
                { ...overrideSettings, exitStrategyOverrideEnabled: false },
            );
            expect(disabled.combinedOOSTrades.totalTrades).to.equal(1);
            expect(disabled.combinedOOSTrades.netProfit).to.equal(10000);
            expect(disabled.combinedOOSTrades.trades[0]!.exitReason).to.equal('end_of_data');

            const zeroKey = 'wfa_spec_exit_zero_signals';
            registerTrackedExitStrategy(zeroKey, makeExitOverrideStrategy(zeroKey, 'sell', () => false));
            const zeroSignals = await runWalkForwardAnalysis(
                gapData,
                entryStrategy,
                baseConfig,
                10_000,
                100,
                0,
                { ...overrideSettings, exitStrategyKey: zeroKey },
            );
            expect(zeroSignals.combinedOOSTrades.netProfit).to.equal(10000);
            expect(zeroSignals.combinedOOSTrades.trades[0]!.exitReason).to.equal('end_of_data');
        });
    });

    it('honors the override through the optimized, fixed-param, and quick paths', async () => {
        await withRegisteredExitStrategies(async () => {
            registerTrackedExitStrategy(
                overrideSettings.exitStrategyKey,
                makeExitOverrideStrategy(overrideSettings.exitStrategyKey, 'sell', (close) => close >= 110),
            );

            const optimizedEntry: Strategy = {
                ...makeEntryStrategy('buy', [20]),
                defaultParams: { entryBar: 20 },
                metadata: { role: 'entry', direction: 'both', walkForwardParams: ['entryBar'] },
                execute: (data, params) => {
                    const signals: Signal[] = [];
                    for (let i = 0; i < data.length; i++) {
                        if (i === Math.trunc(Number(params.entryBar))) {
                            signals.push({ time: data[i]!.time, type: 'buy', price: data[i]!.close });
                        }
                    }
                    return signals;
                },
            };
            const optimized = await runWalkForwardAnalysis(
                gapData,
                optimizedEntry,
                {
                    optimizationWindow: 20,
                    testWindow: 20,
                    stepSize: 20,
                    parameterRanges: [{ name: 'entryBar', min: 19, max: 21, step: 1 }],
                    minTrades: 2,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                overrideSettings,
            );
            expect(optimized.combinedOOSTrades.netProfit).to.equal(1000);
            expect(optimized.combinedOOSTrades.trades[0]!.exitPrice).to.equal(110);

            const fixedEntry = makeEntryStrategy('buy', [30]);
            // Entry at bar 30 with its override exit at bar 32 lands in the
            // second window's OOS half [30, 40).
            const fixedData = makeBars([
                ...Array.from({ length: 31 }, () => ({ close: 100 })),
                { close: 105 },
                { close: 110 },
                ...Array.from({ length: 7 }, () => ({ close: 200 })),
            ]);
            const fixed = await runFixedParamWalkForward(
                fixedData,
                fixedEntry,
                {
                    testWindow: 20,
                    stepSize: 20,
                    minTrades: 1,
                    chartInterval: '1m',
                },
                10_000,
                100,
                0,
                overrideSettings,
            );
            const fixedOosTrade = fixed.combinedOOSTrades.trades.find((trade) => trade.entryPrice === 100);
            expect(fixedOosTrade?.exitPrice).to.equal(110);
            expect(fixed.combinedOOSTrades.netProfit).to.equal(1000);

            const everyBarEntry = makeEntryStrategy('buy', Array.from({ length: 80 }, (_, i) => i));
            const flatData = makeBars(Array.from({ length: 80 }, () => ({ close: 100 })));
            const everyBarExitKey = 'wfa_spec_exit_sell_every_bar';
            registerTrackedExitStrategy(
                everyBarExitKey,
                makeExitOverrideStrategy(everyBarExitKey, 'sell', () => true),
            );
            const quick = await quickWalkForward(
                flatData,
                everyBarEntry,
                10_000,
                100,
                0,
                { ...overrideSettings, exitStrategyKey: everyBarExitKey },
                undefined,
                undefined,
                undefined,
                '1m',
            );
            expect(quick.windows.length).to.be.greaterThan(0);
            expect(quick.combinedOOSTrades.totalTrades).to.be.greaterThan(0);
            expect(quick.combinedOOSTrades.trades.every((trade) => trade.exitReason === 'signal')).to.equal(true);
        });
    });

    it('fails clearly when an active override lacks interval context or a loadable strategy', async () => {
        await withRegisteredExitStrategies(async () => {
            registerTrackedExitStrategy(
                overrideSettings.exitStrategyKey,
                makeExitOverrideStrategy(overrideSettings.exitStrategyKey, 'sell', (close) => close >= 110),
            );
            const entryStrategy = makeEntryStrategy('buy', [20]);

            await assert.rejects(
                runWalkForwardAnalysis(
                    gapData,
                    entryStrategy,
                    {
                        optimizationWindow: 20,
                        testWindow: 20,
                        stepSize: 20,
                        parameterRanges: [],
                        minTrades: 1,
                    },
                    10_000,
                    100,
                    0,
                    overrideSettings,
                ),
                /chartInterval/,
            );

            const missingKey = 'wfa_spec_exit_missing';
            await assert.rejects(
                runWalkForwardAnalysis(
                    gapData,
                    entryStrategy,
                    {
                        optimizationWindow: 20,
                        testWindow: 20,
                        stepSize: 20,
                        parameterRanges: [],
                        minTrades: 1,
                        chartInterval: '1m',
                    },
                    10_000,
                    100,
                    0,
                    { ...overrideSettings, exitStrategyKey: missingKey },
                ),
                new RegExp(missingKey),
            );

            const aborted = new AbortController();
            aborted.abort();
            await assert.rejects(
                runWalkForwardAnalysis(
                    gapData,
                    entryStrategy,
                    {
                        optimizationWindow: 20,
                        testWindow: 20,
                        stepSize: 20,
                        parameterRanges: [],
                        minTrades: 1,
                        chartInterval: '1m',
                        signal: aborted.signal,
                    },
                    10_000,
                    100,
                    0,
                    overrideSettings,
                ),
                /No walk-forward windows/,
            );
        });
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

    it('reuses prepared strategy data during walk-forward optimization for executePrepared strategies', async () => {
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

        let prepareCalls = 0;
        let executePreparedCalls = 0;
        let executeCalls = 0;

        const strategy: Strategy = {
            name: 'Prepared WFA Guard',
            description: 'Ensures walk-forward optimization reuses prepared strategy data.',
            defaultParams: {
                lookback: 12
            },
            paramLabels: {
                lookback: 'Lookback'
            },
            prepareFinderData: (data) => {
                prepareCalls++;
                return { bufferedLength: data.length };
            },
            executePrepared: (preparedData, _params, data) => {
                executePreparedCalls++;
                expect(preparedData).to.deep.equal({ bufferedLength: data.length });
                return [];
            },
            execute: () => {
                executeCalls++;
                throw new Error('walk-forward should not call execute() when executePrepared() is available');
            },
            metadata: {
                role: 'entry',
                direction: 'both',
                walkForwardParams: ['lookback']
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
                    { name: 'lookback', min: 10, max: 14, step: 2 }
                ],
                minTrades: 0,
                topN: 2
            },
            10_000,
            100,
            0.1
        );

        expect(result.windows.length).to.be.greaterThan(0);
        expect(executeCalls).to.equal(0);
        expect(executePreparedCalls).to.be.greaterThan(prepareCalls);
        expect(prepareCalls).to.be.at.most(result.windows.length * 3);
    });

});
