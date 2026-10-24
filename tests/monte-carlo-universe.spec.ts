import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runMonteCarloSimulation, type MonteCarloBacktestInput, type MonteCarloSettings } from '../lib/strategies/monte-carlo/monte-carlo-engine';
import { runBacktest } from '../lib/strategies/backtest/backtest-engine';
import { canonicalUniverseInventory, emptyUniverseRow, projectUniverseMetrics, universeCoverage, universeEffectivePaths,
    universeReplay, universeRowSeed, validateUniverseRequest, validateUniverseTrades, sortUniverseRows, UNIVERSE_LIMITS, universeSnapshot } from '../lib/monte-carlo/universe/model';
import { universeDigest } from '../lib/monte-carlo/universe/store';
import { replayUniverseDetail } from '../lib/monte-carlo/universe/worker';
import { universeRequest, universeManifest } from './helpers/monte-carlo-universe-fixture';
import type { Trade, OHLCVData } from '../lib/types/strategies';
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const input = (trades: Trade[]): MonteCarloBacktestInput => ({ trades, netProfit: trades.reduce((sum, t) => sum + t.pnl, 0), maxDrawdownPercent: 0, sharpeRatio: 0, winRate: 100 });
const settings: MonteCarloSettings = { simulations: 1, seed: 0, initialCapital: 10000, ruinThresholdPercent: 50, enableBootstrap: false, enableSequenceRandomization: false };
function trade(pnl = 22.925): Trade { return { id: 1, type: 'long', entryTime: 1700000000 as Trade['entryTime'], exitTime: 1700086400 as Trade['exitTime'], entryPrice: 100, exitPrice: 110, size: 10, pnl, pnlPercent: pnl / 10, exitReason: 'signal' }; }

it('50/50 gross allocation and ordinary fee-inclusive allocation use independent real execution costs', async () => {
    for (const direction of ['long', 'short'] as const) {
        const candles: OHLCVData[] = [100, 110].map((base, i) => ({ time: (1700000000 + i * 86400) as Trade['entryTime'], open: base / (100 + i * 5), high: base / (100 + i * 5), low: base / (100 + i * 5), close: base / (100 + i * 5), volume: 100,
            pairLegs: [[base, base, base, base, 100 + i * 5, 100 + i * 5, 100 + i * 5, 100 + i * 5]] }));
        const result = runBacktest(candles, [{ time: candles[0].time, type: direction === 'long' ? 'buy' : 'sell', price: 1 },
            { time: candles[1].time, type: direction === 'long' ? 'sell' : 'buy', price: 110 / 105 }], 10000, 10, 0.1,
            { tradeDirection: direction }, { mode: 'fixed', fixedTradeAmount: 1000 });
        near(result.trades[0].pnl, direction === 'long' ? 22.925 : -27.075);
        const trades = Array.from({ length: 5 }, () => result.trades[0]);
        const mc = await runMonteCarloSimulation(input(trades), { ...settings, simulations: 250, enableBootstrap: true }, undefined, undefined,
            { sizing: { mode: 'fixed', fixedTradeAmount: 1000, positionSizePercent: 10, commissionPercent: 0.1, executionMode: 'equal_weight' } });
        assert.equal(mc.status, 'success', mc.errorMessage);
        near(mc.metricSamples.netProfitValues[0], direction === 'long' ? 114.625 : -135.375);
        for (const value of mc.metricSamples.netProfitValues) near(value, mc.metricSamples.netProfitValues[0]);
    }
    for (const [fixedTradeAmount, expected] of [[1000, 114.51048951048506], [1001, 114.625]]) {
        const result = await runMonteCarloSimulation(input(Array.from({ length: 5 }, () => trade())), settings, undefined, undefined,
            { sizing: { mode: 'fixed', fixedTradeAmount, positionSizePercent: 10, commissionPercent: 0.1 } });
        near(result.metricSamples.netProfitValues[0], expected);
    }
});
it('chart partial-record sizing stays compatible, Universe partial controls and records fail explicitly', async () => {
    const trades = Array.from({ length: 6 }, () => ({ ...trade(50), size: 5, exitReason: 'partial' as const }));
    const chart = await runMonteCarloSimulation(input(trades), settings, undefined, undefined, { sizing: { mode: 'fixed', fixedTradeAmount: 1000, positionSizePercent: 10, commissionPercent: 0 } });
    near(chart.metricSamples.netProfitValues[0], 600);
    assert.throws(() => validateUniverseTrades(trades, false), /unsupported_partial_records/);
    for (const sizingMode of ['fixed', 'percent'] as const) for (const field of ['partialTakeProfitAtR', 'partialTakeProfitPercent'] as const) {
        const request = universeRequest(); request.capitalSettings.sizingMode = sizingMode; request.backtestSettings[field] = 1;
        assert.throws(() => validateUniverseRequest(request), /unsupported_partial_exits/);
        request.backtestSettings[field] = 0; request.backtestSettings.exitStrategyOverrideEnabled = true;
        request.backtestSettings.exitStrategyParams = { [field]: 1 };
        assert.throws(() => validateUniverseRequest(request), /unsupported_partial_exits/);
    }
});
it('finite steps that compound to overflow or overflow aggregate moments cannot report success, including replay', async () => {
    const trades = Array.from({ length: 1500 }, () => ({ ...trade(1000), size: 10 }));
    const request = universeRequest(); request.capitalSettings.sizingMode = 'percent'; request.capitalSettings.positionSize = 100; request.capitalSettings.commission = 0;
    request.simulation.simulations = 250;
    const row = emptyUniverseRow(validateUniverseRequest(request).inventory[0], 0, 'evaluated');
    const replay = universeReplay(input(trades), request, row, 250);
    const result = await runMonteCarloSimulation(replay.input, replay.settings, undefined, undefined, { sizing: replay.sizing });
    assert.equal(result.status, 'error'); assert.equal(result.errorMessage, 'non_finite_simulation');
    row.inputDigest = universeDigest(replay);
    await assert.rejects(replayUniverseDetail({ row, replay }), /non_finite_simulation/);
    const extreme = await runMonteCarloSimulation(input(Array.from({ length: 5 }, () => trade(1e160))), settings);
    assert.equal(extreme.status, 'error'); assert.equal(extreme.errorMessage, 'non_finite_simulation');
});
it('summary and stored fixed/percent replay call the same engine without candles and verify input identity', async () => {
    for (const sizingMode of ['fixed', 'percent'] as const) {
        const request = universeRequest(); request.capitalSettings.sizingMode = sizingMode; request.simulation.simulations = 250;
        const row = emptyUniverseRow(validateUniverseRequest(request).inventory[0], 1337, 'evaluated');
        const replay = universeReplay(input(Array.from({ length: 30 }, (_, i) => trade(i % 3 ? 20 : -25))), request, row, 250);
        row.inputDigest = universeDigest(replay);
        const result = await runMonteCarloSimulation(replay.input, replay.settings, undefined, undefined, { sizing: replay.sizing, inputSource: 'universe' });
        const restored = await replayUniverseDetail(JSON.parse(JSON.stringify({ row, replay })));
        assert.deepEqual(restored.result.metricSamples, result.metricSamples);
        assert.deepEqual(projectUniverseMetrics(restored.result, request.criteria), projectUniverseMetrics(result, request.criteria));
        const bad = structuredClone(replay); bad.input.trades[0].pnl++;
        await assert.rejects(replayUniverseDetail({ row, replay: bad }), /digest mismatch/);
    }
});
it('all scalar paths, strict profitability, inclusive verdict edges and interpolated P95 decide the result', async () => {
    const result = await runMonteCarloSimulation(input(Array.from({ length: 5 }, () => trade(1))), settings);
    result.metricSamples.netProfitValues = [-10, 0, 5, 8, 12]; result.simulationsCompleted = 5;
    result.simulations = []; result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95 = 20;
    result.ruinProbabilityMetrics.ruinProbability = result.ruinProbabilityMetrics.ruinRate = 0.25;
    let projected = projectUniverseMetrics(result, { minimumTradeRecords: 5, minimumProfitablePathPercent: 60, maximumP95DrawdownPercent: 20 });
    assert.equal(projected.profitablePathPercent, 60); assert.equal(projected.verdict, 'Pass');
    near(projected.medianReturnPercent, 0.05);
    result.metricSamples.netProfitValues = Array.from({ length: 100 }, (_, i) => i < 90 ? 1 : 0); result.simulationsCompleted = 100;
    projected = projectUniverseMetrics(result, universeRequest().criteria); assert.equal(projected.verdict, 'Pass');
    result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95 = 20.000001;
    assert.equal(projectUniverseMetrics(result, universeRequest().criteria).verdict, 'Fail');
    assert.equal(result.ruinProbabilityMetrics.ruinProbability, 0.25);
    result.metricSamples.maxDrawdownPercentValues = Array.from({ length: 100 }, (_, i) => i);
    result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95 = 94.05;
    result.confidenceIntervals.maxDrawdown.ci95Upper = 96.525;
    assert.equal(projectUniverseMetrics(result, universeRequest().criteria).p95DrawdownPercent, 94.05);
    const known = await runMonteCarloSimulation(input([trade(20), trade(-30), trade(20), trade(0), trade(0)]), { ...settings, initialCapital: 100 });
    near(known.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95, 25);
});
it('canonical aliases, provider inference, modes, ordering and boundaries preserve stable row seeds', () => {
    const source = { provider: 'binance' as const, binanceMarketType: 'spot' as const };
    const rows = canonicalUniverseInventory(['BTC+ETH@', 'BTCUSDT+ETHUSDT@50/50', 'BTC+ETH', 'ETH+BTC', 'BTC', 'BTCUSDT'], source, '1d');
    assert.equal(rows.length, 4);
    assert.equal(canonicalUniverseInventory(['AAPL\u2022+NVDA'], source, '1d')[0].token, 'AAPL\u2022+NVDA\u2022');
    assert.equal(rows[0].mode, 'equal_weight'); assert.equal(rows[1].mode, 'ratio');
    for (const bad of ['BTC+BTCUSDT', '../BTC', 'BTC+ETH@60/40', 'BTC@', 'AAPL\u2022+BTCUSDT', 'BTC+ETH@50/50@', 'BTC/ETH']) assert.throws(() => canonicalUniverseInventory([bad], source, '1d'));
    for (const item of rows) {
        const reordered = canonicalUniverseInventory(['SOL', ...rows.map(r => r.token).reverse()], source, '1d').find(r => r.key === item.key)!;
        assert.equal(universeRowSeed(0, item.key), universeRowSeed(0, reordered.key));
    }
    assert.notEqual(universeRowSeed(0, rows[0].key), universeRowSeed(0, rows[1].key));
    assert.equal(universeEffectivePaths(10000, 1000), 800); assert.equal(universeEffectivePaths(40000, 1000), 200);
    for (const seed of [0, 4294967295]) { const r = universeRequest(); r.simulation.seed = seed; validateUniverseRequest(r); }
    for (const simulations of [249, 10001, Infinity]) { const r = universeRequest(); r.simulation.simulations = simulations; assert.throws(() => validateUniverseRequest(r)); }
    const r = universeRequest(); Object.assign(r.capitalSettings, { initialCapital: 100 }); assert.throws(() => validateUniverseRequest(r), /duplicate_initial_capital/);
});
it('coverage counts each instrument once, zero eligibility is unavailable and 1000-row DTO fits the status ceiling', () => {
    const request = universeRequest(); request.symbols = Array.from({ length: 1000 }, (_, i) => `SYMBOL${i.toString().padStart(115, 'X')}\u2022`);
    const manifest = universeManifest(request); manifest.state = 'completed';
    const rows = manifest.inventory.map(item => emptyUniverseRow(item, 0, 'simulation_failed', 'X'.repeat(256)));
    for (const row of rows) Object.assign(row, { observedReturnPercent: Number.MAX_VALUE, observedDrawdownPercent: Number.MAX_VALUE,
        profitablePaths: 10000, medianReturnPercent: -Number.MAX_VALUE, effectivePaths: 10000 });
    for (const [index, row] of rows.entries()) { row.firstTime = row.lastTime = 1800000000; row.barCount = row.tradeRecords = 100000; row.inputDigest = 'f'.repeat(64); row.rowSeed = 4294967295; if (index < 50) { row.status = 'evaluated'; row.verdict = index < 34 ? 'Pass' : 'Fail'; row.profitablePathPercent = 100 - index; row.p95DrawdownPercent = 20; } else if (index < 58) row.status = 'insufficient_trades'; else if (index < 60) row.status = 'load_failed'; }
    assert.equal(universeCoverage(rows.slice(0, 60)).passRatePercent, 68);
    assert.equal(universeCoverage([]).passRatePercent, null);
    const snapshot = universeSnapshot(manifest, rows);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < UNIVERSE_LIMITS.statusBytes);
    assert.equal(snapshot.counts.requested, 1000);
    rows[999].status = 'evaluated'; rows[999].verdict = 'Pass'; rows[999].profitablePathPercent = 101;
    assert.equal(sortUniverseRows(rows)[0].index, 999);
    for (const asc of [true, false]) assert.equal(sortUniverseRows(rows, 'profitablePathPercent', asc).at(-1)!.profitablePathPercent, null);
});
