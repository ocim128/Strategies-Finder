import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Strategy, Time } from '../lib/strategies/index';
import { quickWalkForward, runWalkForwardAnalysis } from '../lib/strategies/walk-forward';
import { deriveAutoWalkForwardRange, resolveFiniteRangeReferenceValue } from '../lib/walk-forward-range-utils';
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
