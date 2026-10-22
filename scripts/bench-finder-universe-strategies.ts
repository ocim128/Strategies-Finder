/** Read-only local-data benchmark for the four-strategy @50/50 diagnostic.
 * Uses the production worker pool, loader, seeded candidates and runner.
 * npm exec -- esno scripts/bench-finder-universe-strategies.ts --out artifacts/multi-before.json
 * Repeat with --compare artifacts/multi-before.json. Source CSVs must not change.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRealWorkerUniverseStrategyRunner, runFinderUniverseStrategySweep } from '../lib/finder/server/finder-universe-strategy-pool';
import type { FinderUniverseStrategyWorkerTask, FinderUniverseStrategyWorkerResult } from '../lib/finder/server/finder-universe-strategy-worker';

const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const symbolCount = Number(option('symbols', '64'));
const workers = Number(option('workers', '4'));
const runs = Number(option('runs', '3'));
for (const value of [symbolCount, workers, runs]) assert.ok(Number.isInteger(value) && value > 0);
const root = join(process.cwd(), 'price-data/ibkr/csv/30m');
const preferred = 'MSFT NVDA AMZN GOOGL META TSLA AVGO JPM WMT LLY V XOM UNH MA COST HD PG JNJ ABBV BAC NFLX CRM ORCL CVX KO MRK AMD PEP ADBE TMO CSCO ACN MCD ABT LIN GE WFC IBM CAT DIS INTU QCOM VZ TXN AMGN NOW ISRG AMAT PFE GS RTX UBER LOW SPGI UNP HON BKNG PGR COP ETN NEE MU SCHW'.split(' ');
const assets = [...new Set([...preferred, ...readdirSync(root).filter(name => name.endsWith('.csv') && name !== 'AAPL.csv').sort().map(name => name.slice(0, -4))])]
    .filter(asset => existsSync(join(root, `${asset}.csv`))).slice(0, symbolCount);
assert.equal(assets.length, symbolCount, 'Not enough local 30m CSVs');
assert.ok(statSync(join(root, 'AAPL.csv')).size > 0, 'AAPL seed required');
const symbols = assets.map(asset => `${asset}\u2022+AAPL\u2022@50/50`);
const strategyKeys = ['entropy_ratio_regime_alignment', 'short_term_overextension_fade', 'pivot_midpoint_anchor_fade', 'probability_boundary_eigen_shift'];
const sourceIdentity = () => createHash('sha256').update(JSON.stringify(['AAPL', ...assets].map(asset => {
    const file = statSync(join(root, `${asset}.csv`));
    return [asset, file.size, file.mtimeMs];
}))).digest('hex');
const sourceFingerprint = sourceIdentity();
const tasks: FinderUniverseStrategyWorkerTask[] = strategyKeys.map((strategyKey, taskIndex) => ({
    taskIndex, strategyKey, runId: 'equal-weight-benchmark', interval: '30m', symbols,
    settings: { executionModel: 'next_open', tradeDirection: 'long', slippageBps: 5, maxOpenTrades: 1,
        riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 1, takeProfitEnabled: true, takeProfitPercent: 2 },
    capitalSettings: { initialCapital: 10000, positionSize: 10, commission: 0.1, sizingMode: 'fixed', fixedTradeAmount: 1000 },
    options: { scope: 'symbol_universe', mode: 'random', randomSeed: 4242, sortPriority: ['netProfit'], useAdvancedSort: false,
        topN: 5, steps: 3, rangePercent: 25, maxRuns: 2, tradeFilterEnabled: false, minTrades: 0, maxTrades: Infinity,
        universe: { symbols, minActiveSymbols: 0, minTotalTrades: 0, minProfitableActiveRatio: 0, sortPriority: ['medianExpectancy'] } },
    exitStrategyKeys: [], useRustEnginePreference: false,
}));
async function run() {
    const results: FinderUniverseStrategyWorkerResult[] = [];
    const startedAt = performance.now();
    const sweep = await runFinderUniverseStrategySweep({
        tasks, runnerCount: workers, createRunner: createRealWorkerUniverseStrategyRunner,
        onStrategyResult: async (_task, result) => { results.push(result); }, onProgress() {}, isCancelled: () => false,
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(sweep.fatal, null);
    assert.equal(sweep.cancelled, false);
    assert.equal(sweep.completedStrategies, 4);
    assert.equal(sourceIdentity(), sourceFingerprint, 'Source CSVs changed');
    const resultFingerprint = createHash('sha256').update(JSON.stringify(results.map(result => ({
        results: result.results, loadedSymbols: result.loadedSymbols, failedSymbols: result.failedSymbols,
    })), (key, value) => key === 'id' || key === 'runId' ? undefined : value)).digest('hex');
    return { elapsedMs, resultFingerprint, strategies: results.map((result, index) => ({
        strategyKey: strategyKeys[index], loadedSymbols: result.loadedSymbols, failedSymbols: result.failedSymbols,
        timings: result.diagnostics?.timingsMs, backtest: result.diagnostics?.backtest,
        cache: result.datasetCacheDelta,
    })) };
}
async function main() {
    await run();
    const measurements = [];
    for (let index = 0; index < runs; index++) measurements.push(await run());
    for (const row of measurements) assert.equal(row.resultFingerprint, measurements[0]!.resultFingerprint);
    const medianMs = measurements.map(row => row.elapsedMs).sort((a, b) => a - b)[Math.floor(runs / 2)]!;
    const report = { node: process.version, symbolCount, workers, runs, sourceFingerprint,
        resultFingerprint: measurements[0]!.resultFingerprint, medianMs, measurements };
    const compare = option('compare', '');
    if (compare) {
        const baseline = JSON.parse(readFileSync(compare, 'utf8')) as typeof report;
        assert.equal(report.sourceFingerprint, baseline.sourceFingerprint, 'Source CSVs differ');
        assert.equal(report.resultFingerprint, baseline.resultFingerprint, 'Strategy results changed');
        console.log(`Results match; speedup ${(baseline.medianMs / medianMs).toFixed(2)}x (${baseline.medianMs.toFixed(1)} -> ${medianMs.toFixed(1)} ms)`);
    }
    const out = option('out', 'artifacts/universe-multi-strategy.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, medianMs, resultFingerprint: report.resultFingerprint,
        measurements: measurements.map(row => ({ elapsedMs: row.elapsedMs,
            loadingMs: row.strategies.reduce((sum, strategy) => sum + (strategy.timings?.dataLoading ?? 0), 0),
            signalMs: row.strategies.reduce((sum, strategy) => sum + (strategy.timings?.signalGeneration ?? 0), 0),
            backtestMs: row.strategies.reduce((sum, strategy) => sum + (strategy.timings?.backtest ?? 0), 0) })) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
