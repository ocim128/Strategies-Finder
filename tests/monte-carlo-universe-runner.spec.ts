import assert from 'node:assert/strict';
import { it } from 'node:test';
import { executeUniverseRun, replayUniverseDetail } from '../lib/monte-carlo/universe/worker';
import { validateUniverseRequest, type UniverseJournalRecord } from '../lib/monte-carlo/universe/model';
import { createBatchDatasetLoaderCore } from '../lib/batch-backtest/batch-dataset-loader-core';
import { executeBacktest } from '../lib/backtest-executor';
import { loadBuiltInStrategyByKey, strategyRegistry } from '../strategyRegistry';
import { universeRequest, universeCandles } from './helpers/monte-carlo-universe-fixture';
import { DataProviderRouter } from '../lib/data/data-provider-router';
import { state } from '../lib/state';

it('mixed ordinary/ratio/50-50 summary inputs match direct execution in long/short, close/next-open and fixed/percent modes', async () => {
    for (const executionModel of ['signal_close', 'next_open'] as const) for (const tradeDirection of ['long', 'short'] as const) for (const sizingMode of ['fixed', 'percent'] as const) {
        const request = universeRequest(); request.simulation.simulations = 250;
        Object.assign(request.backtestSettings, { executionModel, tradeDirection, confirmationStrategiesToggle: true,
            riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 3, takeProfitEnabled: true, takeProfitPercent: 6,
            disableSignalExits: true, exitStrategyOverrideEnabled: true, exitStrategyKey: 'ema_confirmation', exitStrategyParams: { emaPeriod: 5 },
            confirmationStrategies: ['ema_confirmation'], confirmationStrategyParams: { ema_confirmation: { emaPeriod: 2 } }, confirmationMode: 'agree' });
        request.capitalSettings.sizingMode = sizingMode;
        const data = universeCandles(), quote = universeCandles(true);
        request.blockRange = { from: data[4].time as number, to: data[340].time as number };
        const loader = createBatchDatasetLoaderCore({ logPrefix: 'mc.test', fetchHistorical: async symbol => symbol.includes('MCQUOTE') ? quote : data,
            fetchDetached: async symbol => symbol.includes('MCQUOTE') ? quote : data, acceptOfflineThinData: () => true });
        const inventory = validateUniverseRequest(request).inventory;
        const rows: UniverseJournalRecord[] = [];
        const asOfTimeSec = (data[330].time as number) + 3600;
        await executeUniverseRun({ kind: 'run', request, inventory, asOfTimeSec }, async record => { rows.push(record); }, () => {},
            (symbol, interval, signal) => loader.load(symbol, interval, signal));
        assert.equal(rows.length, 3);
        const strategy = await loadBuiltInStrategyByKey(request.strategyKey);
        for (const record of rows) {
            assert.equal(record.row.status, 'evaluated', `${record.row.token}: ${record.row.reason}`);
            const direct = await executeBacktest({ ohlcvData: await loader.load(record.row.token, request.interval), interval: request.interval,
                primarySymbol: record.row.token, strategyKey: request.strategyKey, strategy, strategyParams: request.strategyParams,
                capitalSettings: { ...request.capitalSettings, initialCapital: request.simulation.initialCapital }, backtestSettings: request.backtestSettings,
                context: { nowSec: asOfTimeSec, blockRange: request.blockRange, engineMode: 'typescript' } });
            assert.deepEqual(record.replay!.input.trades, direct.result.trades.map(t => {
                const { stopLossPrice: _sl, takeProfitPrice: _tp, ...allowlisted } = t; return allowlisted;
            }));
            assert.ok(record.replay!.input.trades.every(t => (t.exitTime as number) < asOfTimeSec));
            assert.equal(!!record.replay!.input.trades[0].legs, record.row.mode === 'equal_weight');
            const detail = await replayUniverseDetail(JSON.parse(JSON.stringify(record)));
            assert.equal(detail.result.simulationsCompleted, record.row.effectivePaths);
            assert.equal(detail.result.inputNetProfit, direct.result.netProfit);
        }
    }
});
it('minimum trade-record boundaries use otherwise valid complete records and do not mislabel zero trades as load failure', async () => {
    const original = await loadBuiltInStrategyByKey('ema_confirmation');
    try {
        for (const minimum of [5, 30]) for (const count of [0, 4, 5, 29, 30, 31]) {
            const request = universeRequest(); request.symbols = ['MCBASE\u2022']; request.simulation.simulations = 250;
            request.criteria.minimumTradeRecords = minimum; request.backtestSettings = { tradeDirection: 'long', executionModel: 'signal_close' };
            strategyRegistry.register('ema_confirmation', { name: 'Boundary fixture', description: '', defaultParams: {}, paramLabels: {}, execute: data =>
                Array.from({ length: count * 2 }, (_, i) => ({ time: data[i].time, price: data[i].close, type: i % 2 ? 'sell' as const : 'buy' as const })) });
            const records: UniverseJournalRecord[] = [];
            await executeUniverseRun({ kind: 'run', request, inventory: validateUniverseRequest(request).inventory, asOfTimeSec: 1800000000 }, async record => { records.push(record); }, () => {}, async () => universeCandles());
            assert.equal(records[0].row.tradeRecords, count);
            assert.equal(records[0].row.status, count >= minimum ? 'evaluated' : 'insufficient_trades');
        }
    } finally { if (original) strategyRegistry.register('ema_confirmation', original); }
});
it('load/backtest errors are counted once and an infrastructure commit rejection is fatal without Batch duplicate notification', async () => {
    const request = universeRequest(); request.simulation.simulations = 250;
    const inventory = validateUniverseRequest(request).inventory;
    let commits = 0;
    await assert.rejects(executeUniverseRun({ kind: 'run', request, inventory, asOfTimeSec: 1800000000 }, async () => {
        commits++; throw new Error('disk full');
    }, () => {}, async () => universeCandles()), /disk full/);
    assert.equal(commits, 1);
    const rows: UniverseJournalRecord[] = [];
    await executeUniverseRun({ kind: 'run', request, inventory, asOfTimeSec: 1800000000 }, async record => { rows.push(record); }, () => {}, async symbol => {
        if (!symbol.includes('+')) throw new Error('source unavailable');
        if (symbol.includes('@')) return universeCandles(); // Missing pair legs is a backtest error.
        return universeCandles().map(bar => ({ ...bar, open: 1, high: 1, low: 1, close: 1 }));
    });
    assert.deepEqual(rows.map(r => r.row.status), ['load_failed', 'insufficient_trades', 'backtest_failed']);
    assert.equal(rows[1].row.tradeRecords, 0);
});
it('captured Spot/Futures/provider routing is independent of unrelated live state changes', () => {
    const original = state.binanceMarketType;
    try {
        const spot = new DataProviderRouter('binance'), futures = new DataProviderRouter('binance-futures'), tradfi = new DataProviderRouter('bybit-tradfi');
        state.binanceMarketType = 'futures'; assert.equal(spot.getProvider('BTCUSDT'), 'binance');
        state.binanceMarketType = 'spot'; assert.equal(futures.getProvider('BTCUSDT'), 'binance-futures');
        assert.equal(tradfi.getProvider('AAPL'), 'bybit-tradfi'); assert.equal(futures.getProvider('AAPL\u2022'), 'ibkr-local');
        assert.equal(futures.getStorageSymbol('BTCUSDT', futures.getProvider('BTCUSDT')), 'BINANCE-FUTURES:BTCUSDT');
    } finally { state.binanceMarketType = original; }
});
