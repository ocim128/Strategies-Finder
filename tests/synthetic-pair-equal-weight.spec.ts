import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSyntheticPairToken, normalizeSyntheticPairProviderMarkers } from '../lib/synthetic-pair-token';
import { parsePortfolioSyntheticPairSymbol } from '../lib/synthetic-pair-parser';
import { createBatchDatasetLoaderCore } from '../lib/batch-backtest/batch-dataset-loader-core';
import { buildSyntheticPairFromLegs, isSyntheticSymbol } from '../scripts/lib/synthetic-pair';
import { runBacktest, runBacktestCompact } from '../lib/strategies/backtest/backtest-engine';
import { buildExecutionAwareCandleWindow } from '../lib/alert-evaluation-window';
import { normalizeStoredStrategyConfig } from '../lib/settings-model';
import { usesFinderPairNeutralMetrics } from '../lib/finder/finder-pair-neutral';
import { computeBacktestEndpointDatasetFingerprint } from '../lib/backtest-endpoint-copy';
import { executeBacktest } from '../lib/backtest-executor';
import { runFinderUniverseExecution } from '../lib/finder/finder-runner-universe';
import { rustEngine } from '../lib/rust-engine-client';
import { parseBatchSymbols } from '../lib/batch-backtest/batch-run-contract';
import { calculateFinderAssetOosSignalMetrics } from '../lib/finder/finder-asset-opportunity-oos';
import { resolveOpenTradeDisplayMetrics } from '../lib/open-trade-display';
import type { BacktestSettings, OHLCVData, Signal, SyntheticPairSample, Strategy } from '../lib/types/strategies';

const PAIR = 'AAPL\u2022+NVDA\u2022';
const sizing = { mode: 'fixed' as const, fixedTradeAmount: 1000 };
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
function candle(index: number, base: number, quote: number): OHLCVData {
    return { time: (172800 + index * 1800) as OHLCVData['time'], open: base / quote, high: base / quote, low: base / quote, close: base / quote, volume: 100,
        pairLegs: [[base, base, base, base, quote, quote, quote, quote]] };
}
function signals(data: OHLCVData[], short = false): Signal[] {
    return [
        { time: data[0].time, type: short ? 'sell' : 'buy', price: data[0].close },
        { time: data[data.length - 1].time, type: short ? 'buy' : 'sell', price: data[data.length - 1].close },
    ];
}
function run(data: OHLCVData[], settings: BacktestSettings = {}, fee = 0) {
    return runBacktest(data, signals(data, settings.tradeDirection === 'short'), 10000, 10, fee, settings, sizing);
}

describe('50/50 synthetic-pair execution', () => {
    it('accepts both suffixes, preserves provider markers and rejects unsupported allocations', () => {
        for (const suffix of ['@', '@50/50']) {
            const normalized = normalizeSyntheticPairProviderMarkers(` aapl\u2022 + nvda${suffix} `);
            assert.equal(normalized, `${PAIR}@50/50`);
            assert.deepEqual(parseSyntheticPairToken(normalized), { baseSymbol: 'AAPL\u2022', quoteSymbol: 'NVDA\u2022', executionMode: 'equal_weight' });
            assert.equal(parsePortfolioSyntheticPairSymbol(`${PAIR}${suffix}`)?.syntheticSymbol, `${PAIR}@50/50`);
            assert.equal(usesFinderPairNeutralMetrics(`${PAIR}${suffix}`), false);
        }
        assert.equal(usesFinderPairNeutralMetrics(PAIR), true);
        assert.deepEqual(parseBatchSymbols(`${PAIR}@ ${PAIR}@50/50 ${PAIR}`), [`${PAIR}@50/50`, PAIR]);
        assert.deepEqual(parseSyntheticPairToken('BTC+ETH@'), { baseSymbol: 'BTCUSDT', quoteSymbol: 'ETHUSDT', executionMode: 'equal_weight' });
        for (const suffix of ['@60/40', '@50/50@', '@foo', '@@']) {
            assert.equal(parseSyntheticPairToken(PAIR + suffix), null);
            assert.equal(parsePortfolioSyntheticPairSymbol(PAIR + suffix), null);
        }
    });

    it('earns $25 for $500 long AAPL + $500 short NVDA, unlike the ratio', () => {
        const data = [candle(0, 200, 100), candle(1, 220, 105)];
        const result = run(data);
        near(result.netProfit, 25);
        near(result.trades[0].pnlPercent, 2.5);
        assert.deepEqual(result.trades[0].legs, {
            base: { side: 'long', size: 2.5, entryPrice: 200, exitPrice: 220, fees: 0 },
            quote: { side: 'short', size: 5, entryPrice: 100, exitPrice: 105, fees: 0 },
        });
        near(result.trades[0].exitPrice, 220 / 105);
        const ratio = data.map(({ pairLegs: _, ...bar }) => bar);
        near(run(ratio).netProfit, 1000 * (1.1 / 1.05 - 1));
        near(run(data, { tradeDirection: 'short' }).netProfit, -25);
    });

    it('holds fixed quantities rather than rebalancing each bar', () => {
        const data = [candle(0, 200, 100), candle(1, 400, 200), candle(2, 440, 200)];
        near(run(data).netProfit, 100);
        const equity = run(data).equityCurve;
        near(equity[1].value, 10000);
        near(equity[2].value, 10100);
    });

    it('uses each execution model\'s actual leg open or close', () => {
        const data = [candle(0, 200, 100), candle(1, 440, 210), candle(2, 660, 300)];
        data[1].pairLegs = [[400, 440, 400, 440, 200, 210, 200, 210]];
        data[2].pairLegs = [[600, 660, 600, 660, 300, 300, 300, 300]];
        const inputs: Signal[] = [
            { time: data[0].time, type: 'buy', price: 2 },
            { time: data[1].time, type: 'sell', price: data[1].close },
        ];
        const expected = { signal_close: 50, next_open: 0, next_close: 500 * (660 / 440 - 300 / 210) };
        for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
            const result = runBacktest(data, inputs, 10000, 10, 0, { executionModel }, sizing);
            near(result.netProfit, expected[executionModel]);
        }
    });

    it('accounts for a short leg loss exceeding its original notional', () => {
        near(run([candle(0, 200, 100), candle(1, 200, 400)]).netProfit, -1500);
    });

    it('sizes each overlapping entry from its own leg prices', () => {
        const data = [candle(0, 200, 100), candle(1, 400, 200), candle(2, 440, 200)];
        const result = runBacktest(data, [
            { ...signals(data)[0] },
            { time: data[1].time, type: 'buy', price: data[1].close },
        ], 10000, 10, 0, { maxOpenTrades: 2 }, sizing);
        near(result.netProfit, 150); // first entry $100; second entry $50
        assert.deepEqual(result.trades.map(trade => trade.legs?.base.size), [2.5, 1.25]);
    });

    it('charges entry and exit commission on the separate leg notionals', () => {
        const data = [candle(0, 200, 100), candle(1, 400, 200)];
        const result = run(data, {}, 0.1);
        near(result.netProfit, -3); // $1 entry; $2 closing the now-$2000 gross portfolio
        near(result.trades[0].fees!, 3);
    });

    it('uses the first source sample touching a target to calculate exit fees', () => {
        const data = [candle(0, 200, 100), candle(1, 200, 100), candle(2, 200, 100)];
        data[1].pairLegs = [
            [200, 240, 200, 200, 100, 100, 100, 100],
            [2020, 2020, 2020, 2020, 1000, 1000, 1000, 1000],
        ];
        const result = run(data, { riskMode: 'percentage', takeProfitEnabled: true, takeProfitPercent: 5 }, 0.1);
        near(result.trades[0].fees!, 2.05);
        near(result.netProfit, 47.95);
        near(result.trades[0].legs!.base.exitPrice, 220);
        near(result.trades[0].legs!.quote.exitPrice, 100);
    });

    it('measures Asset Opportunity fixed-horizon returns from both legs', () => {
        const data = [candle(0, 200, 100), candle(1, 220, 105)];
        for (const direction of ['long', 'short'] as const) {
            const result = calculateFinderAssetOosSignalMetrics({ candles: data, signalIndex: 0, entryPrice: 2, direction, ignoreLastBars: 1, horizons: [1] });
            near(result.horizons[0].pnlPercent!, direction === 'long' ? 2.5 : -2.5);
            const nextOpen = calculateFinderAssetOosSignalMetrics({ candles: data, signalIndex: 0, entryPrice: data[1].open, direction,
                ignoreLastBars: 1, horizons: [1], pairEntryPrices: [220, 105] });
            near(nextOpen.horizons[0].pnlPercent!, 0);
        }
    });

    it('applies slippage to both entry legs and both exit legs', () => {
        const data = [candle(0, 200, 100), candle(1, 200, 100)];
        for (const tradeDirection of ['long', 'short'] as const) {
            const s = 0.001;
            const expected = 500 * ((1 - s) / (1 + s) - 1) + 500 * (1 - (1 + s) / (1 - s));
            const result = run(data, { tradeDirection, slippageBps: 10 });
            near(result.netProfit, expected);
            const trade = result.trades[0];
            near(trade.size * trade.entryPrice, 1000);
            near(trade.legs!.base.size * trade.legs!.base.entryPrice, 500);
            near(trade.legs!.quote.size * trade.legs!.quote.entryPrice, 500);
        }
    });

    it('keeps open-trade display PNL on the actual leg basis', () => {
        const data = [candle(0, 200, 100), candle(1, 220, 105)];
        const result = runBacktest(data, [signals(data)[0]], 10000, 10, 0, {}, sizing);
        assert.equal(result.trades[0].exitReason, 'end_of_data');
        const display = resolveOpenTradeDisplayMetrics(result.trades[0], data[1]);
        near(display.pnl, 25);
        near(display.pnlPercent, 2.5);
    });

    it('uses combined portfolio returns for stop losses, profit targets and drawdown', () => {
        const data = [candle(0, 200, 100), candle(1, 240, 110), candle(2, 240, 110)];
        const result = run(data, { riskMode: 'percentage', takeProfitEnabled: true, takeProfitPercent: 4 });
        near(result.netProfit, 40);
        assert.equal(result.trades[0].exitReason, 'take_profit');
        const down = [candle(0, 200, 100), candle(1, 180, 105), candle(2, 180, 105)];
        const stopped = run(down, { riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 5 });
        near(stopped.netProfit, -75); // stop gap fills at the open's -7.5%
        assert.equal(stopped.trades[0].exitReason, 'stop_loss');
        near(run(down).maxDrawdown, 75);
    });

    it('fills long and short intrabar targets from retained source-leg samples', () => {
        for (const tradeDirection of ['long', 'short'] as const) {
            const data = [candle(0, 200, 100), candle(1, 200, 100), candle(2, 200, 100)];
            data[1].pairLegs = [[200, 240, 160, 200, 100, 100, 100, 100]];
            const tp = run(data, { tradeDirection, riskMode: 'percentage', takeProfitEnabled: true, takeProfitPercent: 5 });
            near(tp.netProfit, 50);
            assert.equal(tp.trades[0].exitReason, 'take_profit');
            const sl = run(data, { tradeDirection, riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 5 });
            near(sl.netProfit, -50);
            assert.equal(sl.trades[0].exitReason, 'stop_loss');
        }
    });

    for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
        for (const tradeDirection of ['long', 'short', 'both', 'both_no_flip', 'combined'] as const) {
            it(`keeps full and Finder compact results equal for ${executionModel}/${tradeDirection}`, () => {
                const data = Array.from({ length: 18 }, (_, i) => candle(i, 200 + i * 3 + (i % 3) * 9, 100 + i * 2));
                const inputs: Signal[] = [0, 3, 6, 9, 12].map((i, j) => ({ time: data[i].time, type: j % 2 ? 'sell' : 'buy', price: data[i].close }));
                const settings = { executionModel, tradeDirection, maxOpenTrades: 2 };
                const full = runBacktest(data, inputs, 10000, 10, 0.1, settings, sizing);
                const compact = runBacktestCompact(data, inputs, 10000, 10, 0.1, settings, sizing, undefined, {
                    omitEquityCurve: true, requireTradeHistory: true, collectDiagnostics: true,
                });
                for (const key of ['netProfit', 'totalTrades', 'winningTrades', 'maxDrawdown', 'maxDrawdownPercent', 'sharpeRatio'] as const) near(compact[key], full[key]);
                assert.deepEqual(compact.trades, full.trades);
            });
        }
    }

    it('closes partial exits in equal fractions of both original leg quantities', () => {
        const data = [candle(0, 200, 100), candle(1, 220, 100), candle(2, 240, 100)];
        const inputs = signals(data);
        inputs.splice(1, 0, { time: data[1].time, price: data[1].close, type: 'sell', sizeFraction: 0.5 });
        const result = runBacktest(data, inputs, 10000, 10, 0, {}, sizing);
        near(result.netProfit, 75);
        assert.equal(result.trades.length, 2);
        near(result.trades[0].size, result.trades[1].size);
    });

    it('excludes future leg prices from an unfinished next-open bridge candle', () => {
        const closed = candle(0, 200, 100);
        const future = { ...candle(1, 200, 100), pairLegs: [[200, 900, 1, 800, 100, 700, 2, 600] as SyntheticPairSample] };
        const window = buildExecutionAwareCandleWindow([closed], future, { executionModel: 'next_open' });
        assert.deepEqual(window[1].pairLegs, [[200, 200, 200, 200, 100, 100, 100, 100]]);
        near(runBacktest(window, [signals(window)[0]], 10000, 10, 0, { executionModel: 'next_open' }, sizing).netProfit, 0);
    });

    it('rejects missing leg data instead of falling back silently to ratio accounting', () => {
        const data = [candle(0, 200, 100), candle(1, 220, 105)];
        delete data[1].pairLegs;
        assert.throws(() => run(data), /aligned positive leg prices/);
    });

    it('preserves execution mode in saved configs while keeping legacy configs valid', () => {
        const raw = { name: 'Pair', strategyKey: 'test', syntheticPair: { baseSymbol: 'AAPL\u2022', quoteSymbol: 'NVDA\u2022', executionMode: 'equal_weight' } };
        const config = normalizeStoredStrategyConfig(raw)!;
        assert.deepEqual(config.syntheticPair, raw.syntheticPair);
        assert.equal(isSyntheticSymbol(`${PAIR}@50/50`, config.syntheticPair!), true);
        assert.equal(isSyntheticSymbol(PAIR, config.syntheticPair!), false);
        assert.deepEqual(normalizeStoredStrategyConfig({ ...raw, syntheticPair: { baseSymbol: 'AAPL\u2022', quoteSymbol: 'NVDA\u2022' } })!.syntheticPair,
            { baseSymbol: 'AAPL\u2022', quoteSymbol: 'NVDA\u2022' });
    });

    it('keeps @ cache entries distinct and retains aligned sub-bars through loader reuse', async () => {
        const base = [200, 210, 220, 230, 240, 250, 260, 270].map((p, i) => ({ ...candle(i, p, 1), open: p, high: p, low: p, close: p }));
        const quote = base.map(bar => ({ ...bar, open: 100, high: 100, low: 100, close: 100 }));
        let diskReads = 0;
        const loader = createBatchDatasetLoaderCore({
            logPrefix: 'equal.test', fetchDetached: async () => [],
            fetchHistorical: async symbol => symbol === 'AAPL\u2022' ? base : quote,
            loadCachedSyntheticPair: async () => { diskReads++; return null; },
        });
        const ratio = await loader.load(PAIR, '4h');
        assert.equal(ratio[0].pairLegs, undefined);
        const readsBefore = diskReads;
        const pair = await loader.load(`${PAIR}@`, '4h');
        assert.equal(diskReads, readsBefore, 'ratio-only disk caches must be bypassed');
        assert.equal(pair[0].pairLegs?.length, 8);
        assert.deepEqual(pair.map(({ pairLegs: _, ...bar }) => bar), ratio);
        assert.strictEqual(await loader.load(`${PAIR}@50/50`, '4h'), pair);
        const metadata = await loader.loadWithMetadata(`${PAIR}@`, '4h');
        assert.strictEqual(metadata.data, pair);
        assert.deepEqual(metadata.baseCloses, [270]);
        assert.notEqual(computeBacktestEndpointDatasetFingerprint(pair), computeBacktestEndpointDatasetFingerprint(ratio));
    });

    it('builds equal-weight samples for generic time shapes and target-interval fallback', async () => {
        const result = await buildSyntheticPairFromLegs({
            baseSymbol: 'AAPL\u2022', quoteSymbol: 'NVDA\u2022', interval: '1d', targetBars: 2, executionMode: 'equal_weight',
            fetchLeg: async (symbol, interval) => interval !== '1d' ? [] : [{
                time: '2025-01-01', open: symbol === 'AAPL\u2022' ? 200 : 100, high: 220, low: 90, close: 150, volume: 1,
            }],
        });
        assert.equal(result.bars[0].pairLegs?.length, 1);
    });

    for (const rustAvailable of [true, false]) {
        it(`uses two-leg TypeScript accounting when Rust is ${rustAvailable ? 'available' : 'unavailable'}`, async t => {
            const data = [candle(0, 200, 100), candle(1, 210, 102), candle(2, 220, 105)];
            const health = t.mock.method(rustEngine, 'checkHealth', async () => rustAvailable);
            const remote = t.mock.method(rustEngine, 'runBacktestWithStatus', async () => { throw new Error('Rust cannot execute pair legs'); });
            const strategy: Strategy = { name: 'Pair test', description: 'Pair test', defaultParams: {}, paramLabels: {}, execute: bars => signals(bars) };
            const output = await executeBacktest({
                ohlcvData: data, closedCandleDataOverride: data, interval: '30m', primarySymbol: `${PAIR}@`,
                strategyKey: 'pair_test', strategy, strategyParams: {},
                backtestSettings: { executionModel: 'signal_close', tradeDirection: 'long' },
                capitalSettings: { initialCapital: 10000, positionSize: 10, commission: 0, sizingMode: 'fixed', fixedTradeAmount: 1000 },
                context: { engineMode: 'rust_preferred', useRustEnginePreference: true, nowSec: 200000, blockRange: null },
                backtestRunOptions: { skipResultPostProcessing: true },
            });
            near(output.result.netProfit, 25);
            assert.equal(output.engineUsed, 'typescript');
            assert.match(output.engineDiagnostics?.typescriptReason ?? '', /50\/50/);
            assert.equal(health.mock.callCount(), 0);
            assert.equal(remote.mock.callCount(), 0);
            const { pairLegs: _, ...ratioOnly } = data[0];
            await assert.rejects(() => executeBacktest({
                ohlcvData: [ratioOnly], closedCandleDataOverride: [ratioOnly], interval: '30m', primarySymbol: `${PAIR}@`,
                strategyKey: 'pair_test', strategy, strategyParams: {}, preGeneratedSignals: signals([ratioOnly]),
                backtestSettings: { executionModel: 'signal_close' }, capitalSettings: {}, context: { engineMode: 'typescript', nowSec: 200000, blockRange: null },
            }), /execution legs are missing/);
        });
    }

    it('ranks Finder universe candidates using dollar leg results and deduplicates suffix aliases', async t => {
        const data = [candle(0, 200, 100), candle(1, 210, 102), candle(2, 220, 105)];
        const remote = t.mock.method(rustEngine, 'runBatchBacktestWithStatus', async () => { throw new Error('no ratio-only batching'); });
        const output = await runFinderUniverseExecution({
            interval: '30m', settings: { executionModel: 'signal_close', tradeDirection: 'short' },
            capitalSettings: { initialCapital: 10000, positionSize: 10, commission: 0, sizingMode: 'fixed', fixedTradeAmount: 1000 },
            selectedStrategy: { key: 'pair_test', name: 'Pair test', strategy: {
                name: 'Pair test', description: 'Pair test', defaultParams: { k: 1 }, paramLabels: { k: 'K' }, execute: bars => signals(bars, true),
            } },
            options: { scope: 'symbol_universe', mode: 'random', sortPriority: ['netProfit'], useAdvancedSort: false,
                topN: 2, steps: 1, rangePercent: 0, maxRuns: 2, tradeFilterEnabled: false, minTrades: 0, maxTrades: Infinity,
                universe: { symbols: [`${PAIR}@`, `${PAIR}@50/50`], minActiveSymbols: 1, minTotalTrades: 1, minProfitableActiveRatio: 0, sortPriority: ['medianExpectancy'] },
            },
            loadDataset: async () => data, generateParamSets: () => [{ k: 1 }, { k: 2 }], useRustEnginePreference: true,
        }, { setProgress() {}, setStatus() {}, yieldControl: async () => {}, isCancelled: () => false });
        assert.equal(output.results.length, 2);
        for (const candidate of output.results) {
            assert.equal(candidate.symbols.length, 1);
            near(candidate.symbols[0].result!.netProfit, -25);
            assert.equal(candidate.symbols[0].result!.metricBasis, undefined);
        }
        assert.equal(remote.mock.callCount(), 0);
        assert.ok(output.diagnostics?.universe?.engineUsage?.typescriptReasons.some(reason => /50\/50/.test(reason.reason)));
    });
});
