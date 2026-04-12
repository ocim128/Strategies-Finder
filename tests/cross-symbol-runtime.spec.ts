import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Strategy, BacktestSettings } from '../lib/types/strategies';
import {
    resolveCrossSymbolExecution,
    resolveCrossSymbolExecutionSync,
    isCrossSymbolStrategy,
    guardCrossSymbolUnsupported,
} from '../lib/cross-symbol-runtime';
import { CrossSymbolAlignmentError } from '../lib/strategies/lib/cross-symbol-helpers';

function bar(time: number, close: number): OHLCVData {
    return { time, open: close, high: close, low: close, close, volume: 100 };
}

function makeStrategy(withCrossSymbol = true): Strategy {
    return {
        name: 'Test Strategy',
        description: 'test',
        defaultParams: { lookback: 20 },
        paramLabels: { lookback: 'Lookback' },
        crossSymbolConfig: withCrossSymbol
            ? { defaultSymbol: 'ETHUSDT', minBars: 5 }
            : undefined,
        execute: () => [],
    } as Strategy;
}

const defaultSettings: BacktestSettings = {
    strategyTimeframeEnabled: false,
    crossSymbolSecondary: '',
} as BacktestSettings;

function makeFetcher(secondaryData: OHLCVData[], provider = 'binance') {
    return {
        getProvider: () => provider,
        fetchDataDetached: async () => secondaryData,
    };
}

// ============================================================================
// resolveCrossSymbolExecution — passthrough
// ============================================================================

describe('resolveCrossSymbolExecution', () => {
    it('passes through unchanged for non-cross-symbol strategies', async () => {
        const strategy = makeStrategy(false);
        const primaryData = [bar(1, 100), bar(2, 101)];
        const result = await resolveCrossSymbolExecution({
            strategy,
            primarySymbol: 'BTCUSDT',
            interval: '5m',
            primaryData,
            settings: defaultSettings,
            dataFetcher: makeFetcher([]),
        });
        expect(result.primaryData).to.equal(primaryData);
        expect(result.context).to.be.undefined;
    });

    it('rejects primary === secondary', async () => {
        const strategy = makeStrategy(true);
        const settings = { ...defaultSettings, crossSymbolSecondary: 'BTCUSDT' };
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData: [bar(1, 100)],
                settings,
                dataFetcher: makeFetcher([]),
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
            expect((err as Error).message).to.include('cannot be the same');
        }
    });

    it('rejects primary === secondary regardless of casing', async () => {
        const strategy = makeStrategy(true);
        const settings = { ...defaultSettings, crossSymbolSecondary: 'btcusdt' };
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData: [bar(1, 100)],
                settings,
                dataFetcher: makeFetcher([]),
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
        }
    });

    it('rejects provider mismatch', async () => {
        const strategy = makeStrategy(true);
        const fetcher = {
            getProvider: (symbol: string) => symbol === 'BTCUSDT' ? 'binance' : 'coinbase',
            fetchDataDetached: async () => [],
        };
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData: [bar(1, 100)],
                settings: defaultSettings,
                dataFetcher: fetcher,
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
            expect((err as Error).message).to.include('Provider mismatch');
        }
    });

    it('rejects when secondary data is empty', async () => {
        const strategy = makeStrategy(true);
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData: [bar(1, 100)],
                settings: defaultSettings,
                dataFetcher: makeFetcher([]),
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
            expect((err as Error).message).to.include('No data available');
        }
    });

    it('rejects strategyTimeframeEnabled + cross-symbol', async () => {
        const strategy = makeStrategy(true);
        const settings = { ...defaultSettings, strategyTimeframeEnabled: true };
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData: [bar(1, 100)],
                settings,
                dataFetcher: makeFetcher([]),
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
            expect((err as Error).message).to.include('timeframe');
        }
    });

    it('rejects when aligned length is below minBars', async () => {
        const strategy = makeStrategy(true);
        const primaryData = [bar(10, 100), bar(20, 101)];
        const secondaryData = [bar(10, 200), bar(20, 201)];
        try {
            await resolveCrossSymbolExecution({
                strategy,
                primarySymbol: 'BTCUSDT',
                interval: '5m',
                primaryData,
                settings: defaultSettings,
                dataFetcher: makeFetcher(secondaryData),
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
        }
    });

    it('resolves and aligns when data is sufficient', async () => {
        const strategy = makeStrategy(true);
        const primaryData = Array.from({ length: 20 }, (_, i) => bar(10 + i * 10, 100 + i));
        const secondaryData = Array.from({ length: 20 }, (_, i) => bar(10 + i * 10, 200 + i));
        const result = await resolveCrossSymbolExecution({
            strategy,
            primarySymbol: 'BTCUSDT',
            interval: '5m',
            primaryData,
            settings: defaultSettings,
            dataFetcher: makeFetcher(secondaryData),
        });
        expect(result.context).to.not.be.undefined;
        expect(result.context!.crossSymbol!.secondarySymbol).to.equal('ETHUSDT');
        expect(result.context!.crossSymbol!.secondaryData).to.have.length(20);
        expect(result.context!.crossSymbol!.alignedLength).to.equal(20);
        expect(result.context!.crossSymbol!.trimmedLeadingBars).to.equal(0);
    });

    it('uses crossSymbolSecondary override when set', async () => {
        const strategy = makeStrategy(true);
        const primaryData = Array.from({ length: 20 }, (_, i) => bar(10 + i * 10, 100 + i));
        const secondaryData = Array.from({ length: 20 }, (_, i) => bar(10 + i * 10, 200 + i));
        const settings = { ...defaultSettings, crossSymbolSecondary: 'SOLUSDT' };
        const result = await resolveCrossSymbolExecution({
            strategy,
            primarySymbol: 'BTCUSDT',
            interval: '5m',
            primaryData,
            settings,
            dataFetcher: makeFetcher(secondaryData),
        });
        expect(result.context!.crossSymbol!.secondarySymbol).to.equal('SOLUSDT');
    });

    it('trims leading bars where secondary has no match', async () => {
        const strategy = makeStrategy(true);
        const primaryData = Array.from({ length: 20 }, (_, i) => bar(5 + i * 5, 100 + i));
        const secondaryData = Array.from({ length: 15 }, (_, i) => bar(30 + i * 5, 200 + i));
        const result = await resolveCrossSymbolExecution({
            strategy,
            primarySymbol: 'BTCUSDT',
            interval: '5m',
            primaryData,
            settings: defaultSettings,
            dataFetcher: makeFetcher(secondaryData),
        });
        expect(result.context).to.not.be.undefined;
        expect(result.context!.crossSymbol!.trimmedLeadingBars).to.be.greaterThan(0);
    });
});

// ============================================================================
// resolveCrossSymbolExecutionSync
// ============================================================================

describe('resolveCrossSymbolExecutionSync', () => {
    it('passes through for non-cross-symbol strategies', () => {
        const strategy = makeStrategy(false);
        const primaryData = [bar(1, 100)];
        const result = resolveCrossSymbolExecutionSync({
            strategy,
            primarySymbol: 'BTCUSDT',
            primaryData,
            secondarySymbol: 'ETHUSDT',
            secondaryData: [bar(1, 200)],
            settings: defaultSettings,
        });
        expect(result.primaryData).to.equal(primaryData);
        expect(result.context).to.be.undefined;
    });

    it('rejects primary === secondary', () => {
        const strategy = makeStrategy(true);
        try {
            resolveCrossSymbolExecutionSync({
                strategy,
                primarySymbol: 'BTCUSDT',
                primaryData: [bar(1, 100)],
                secondarySymbol: 'BTCUSDT',
                secondaryData: [bar(1, 200)],
                settings: defaultSettings,
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
        }
    });

    it('rejects strategyTimeframeEnabled', () => {
        const strategy = makeStrategy(true);
        try {
            resolveCrossSymbolExecutionSync({
                strategy,
                primarySymbol: 'BTCUSDT',
                primaryData: [bar(1, 100)],
                secondarySymbol: 'ETHUSDT',
                secondaryData: [bar(1, 200)],
                settings: { ...defaultSettings, strategyTimeframeEnabled: true },
            });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(CrossSymbolAlignmentError);
        }
    });

    it('resolves aligned context', () => {
        const strategy = makeStrategy(true);
        const primaryData = Array.from({ length: 10 }, (_, i) => bar(10 + i, 100 + i));
        const secondaryData = Array.from({ length: 10 }, (_, i) => bar(10 + i, 200 + i));
        const result = resolveCrossSymbolExecutionSync({
            strategy,
            primarySymbol: 'BTCUSDT',
            primaryData,
            secondarySymbol: 'ETHUSDT',
            secondaryData,
            settings: defaultSettings,
        });
        expect(result.context).to.not.be.undefined;
        expect(result.context!.crossSymbol!.alignedLength).to.equal(10);
    });
});

// ============================================================================
// isCrossSymbolStrategy / guardCrossSymbolUnsupported
// ============================================================================

describe('isCrossSymbolStrategy', () => {
    it('returns true for cross-symbol strategy', () => {
        expect(isCrossSymbolStrategy(makeStrategy(true))).to.equal(true);
    });

    it('returns false for single-symbol strategy', () => {
        expect(isCrossSymbolStrategy(makeStrategy(false))).to.equal(false);
    });
});

describe('guardCrossSymbolUnsupported', () => {
    it('throws for cross-symbol strategy', () => {
        try {
            guardCrossSymbolUnsupported(makeStrategy(true), 'Test Surface');
            expect.fail('should have thrown');
        } catch (err) {
            expect((err as Error).message).to.include('Test Surface');
        }
    });

    it('does not throw for single-symbol strategy', () => {
        guardCrossSymbolUnsupported(makeStrategy(false), 'Test Surface');
    });
});
