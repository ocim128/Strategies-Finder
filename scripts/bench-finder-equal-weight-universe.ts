/** Deterministic cold Universe workload matching the 30m, two-candidate
 * cumulative-return @50/50 diagnostic. No disk cache or network required.
 * npm exec -- esno scripts/bench-finder-equal-weight-universe.ts --out artifacts/universe-before.json
 * Repeat with --compare artifacts/universe-before.json to check result parity.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runFinderUniverseExecution } from '../lib/finder/finder-runner-universe';
import { createBatchDatasetLoaderCore } from '../lib/batch-backtest/batch-dataset-loader-core';
import { cumulative_return_percentile_reversion as strategy } from '../lib/strategies/lib/cumulative_return_percentile_reversion';
import type { OHLCVData } from '../lib/types/strategies';
import type { FinderOptions } from '../lib/types/finder';

const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const bars = Number(option('bars', '24000'));
const symbolCount = Number(option('symbols', '64'));
const runs = Number(option('runs', '3'));
for (const value of [bars, symbolCount, runs]) assert.ok(Number.isInteger(value) && value > 0);
function makeLeg(seed: number): OHLCVData[] {
    let price = 100;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    return Array.from({ length: bars }, (_, index) => {
        const open = price;
        const close = price = Math.max(1, open * (1 + (random() - 0.5) * 0.025));
        return { time: (1699999200 + index * 1800) as OHLCVData['time'], open, close,
            high: Math.max(open, close) * 1.006, low: Math.min(open, close) * 0.994, volume: 1000 };
    });
}
const symbols = Array.from({ length: symbolCount }, (_, index) => `LEG${index}\u2022+ANCHOR\u2022@50/50`);
const options: FinderOptions = {
    scope: 'symbol_universe', mode: 'random', sortPriority: ['netProfit'], useAdvancedSort: false,
    topN: 5, steps: 1, rangePercent: 0, maxRuns: 2, tradeFilterEnabled: false,
    minTrades: 0, maxTrades: Infinity,
    universe: { symbols, minActiveSymbols: 1, minTotalTrades: 1, minProfitableActiveRatio: 0,
        sortPriority: ['medianExpectancy'] },
};
async function run() {
    const loader = createBatchDatasetLoaderCore({
        logPrefix: 'bench.equal_weight',
        fetchDetached: async () => { throw new Error('Unexpected detached fetch'); },
        fetchHistorical: async symbol => makeLeg(symbol === 'ANCHOR\u2022' ? 47821 : 9000 + Number(symbol.match(/\d+/)?.[0])),
    });
    const startedAt = performance.now();
    const output = await runFinderUniverseExecution({
        interval: '30m', options,
        settings: { executionModel: 'next_open', tradeDirection: 'long', slippageBps: 5, maxOpenTrades: 1,
            riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 1, takeProfitEnabled: true, takeProfitPercent: 2 },
        capitalSettings: { initialCapital: 10000, positionSize: 10, commission: 0.1, sizingMode: 'fixed', fixedTradeAmount: 1000 },
        selectedStrategy: { key: 'cumulative_return_percentile_reversion', name: strategy.name, strategy },
        loadDataset: (symbol, interval, signal) => loader.load(symbol, interval, signal),
        generateParamSets: () => [{ lookback: 87, pctlExtreme: 0.999 }, { lookback: 87, pctlExtreme: 0.95 }],
    }, { setProgress() {}, setStatus() {}, isCancelled: () => false, yieldControl: async () => {} });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(output.loadedSymbols, symbolCount);
    assert.equal(output.results.length, 2);
    const resultFingerprint = createHash('sha256').update(JSON.stringify(output.results, (key, value) =>
        key === 'id' || key === 'runId' ? undefined : value)).digest('hex');
    return { elapsedMs, resultFingerprint, timings: output.diagnostics?.timingsMs,
        backtest: output.diagnostics?.backtest, memory: process.memoryUsage(), cache: loader.getCacheStats() };
}
async function main() {
    await run();
    const measurements = [];
    for (let index = 0; index < runs; index++) measurements.push(await run());
    for (const measurement of measurements) assert.equal(measurement.resultFingerprint, measurements[0]!.resultFingerprint);
    const medianMs = measurements.map(row => row.elapsedMs).sort((a, b) => a - b)[Math.floor(runs / 2)]!;
    const report = { node: process.version, bars, symbolCount, runs, medianMs, resultFingerprint: measurements[0]!.resultFingerprint, measurements };
    const compare = option('compare', '');
    if (compare) {
        const baseline = JSON.parse(readFileSync(compare, 'utf8')) as typeof report;
        assert.equal(bars, baseline.bars);
        assert.equal(symbolCount, baseline.symbolCount);
        assert.equal(report.resultFingerprint, baseline.resultFingerprint, 'Universe results changed');
        console.log(`Results match; speedup ${(baseline.medianMs / medianMs).toFixed(2)}x (${baseline.medianMs.toFixed(1)} -> ${medianMs.toFixed(1)} ms)`);
    }
    const out = option('out', 'artifacts/equal-weight-universe.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, medianMs, resultFingerprint: report.resultFingerprint, measurements: measurements.map(row => ({ elapsedMs: row.elapsedMs, timings: row.timings, memory: row.memory })) }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
