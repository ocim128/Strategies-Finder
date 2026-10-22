/** Repeatable 50/50 Finder workload; --compare verifies unchanged result fingerprints.
 * npm exec -- esno scripts/bench-synthetic-equal-weight.ts --out artifacts/pair-perf.json
 * Timings exclude report hashing/I/O. Data is deterministic, not downloaded.
 */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSyntheticPairFromLegs } from './lib/synthetic-pair';
import { true_range_skew_acceptance } from '../lib/strategies/lib/true_range_skew_acceptance';
import { runBacktestCompact } from '../lib/strategies/backtest/backtest-engine';
import type { BacktestResult, OHLCVData } from '../lib/types/strategies';

const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const barCount = Number(option('bars', '24000'));
const runs = Number(option('runs', '9'));
if (!Number.isInteger(barCount) || barCount < 32 || !Number.isInteger(runs) || runs < 1) throw new Error('Invalid --bars/--runs');
let seed = 47821;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
function leg(start: number): OHLCVData[] {
    let price = start;
    return Array.from({ length: barCount }, (_, index) => {
        const open = price;
        const close = price = Math.max(1, open * (1 + (random() - 0.48) * 0.025));
        return { time: (1699999200 + index * 1800) as OHLCVData['time'], open, close,
            high: Math.max(open, close) * (1 + random() * 0.006), low: Math.min(open, close) * (1 - random() * 0.006), volume: 1000 };
    });
}
async function main(): Promise<void> {
    const base = leg(200), quote = leg(100);
    const build = (interval = '30m') => buildSyntheticPairFromLegs({
        baseSymbol: 'BASE\u2022', quoteSymbol: 'QUOTE\u2022', interval, targetBars: barCount,
        assumeNormalizedLegs: true, executionMode: 'equal_weight', fetchLeg: async symbol => symbol === 'BASE\u2022' ? base : quote,
    });
    const dataset = (await build()).bars;
    const strategy = true_range_skew_acceptance;
    const generate = () => strategy.execute(dataset, strategy.defaultParams);
    const signals = generate();
    const closeSettings = { executionModel: 'signal_close' as const, tradeDirection: 'long' as const, slippageBps: 5, maxOpenTrades: 1,
        riskMode: 'percentage' as const, stopLossEnabled: true, stopLossPercent: 1, takeProfitEnabled: true, takeProfitPercent: 2 };
    const closeReference = runBacktestCompact(dataset, signals, 10000, 10, 0.1, closeSettings, { mode: 'fixed', fixedTradeAmount: 1000 }, undefined,
        { omitEquityCurve: false, includeSharpeRatio: false, requireTradeHistory: true });
    function summarize(result: BacktestResult) {
        const { diagnostics: _, ...stable } = result;
        return stable;
    }
    const simulate = (model: 'signal_close' | 'next_open', sharpe: boolean, sparse = false) => runBacktestCompact(
        dataset, signals, 10000, 10, 0.1,
        { executionModel: model, tradeDirection: 'long', slippageBps: 5, maxOpenTrades: 1,
            riskMode: 'percentage', stopLossEnabled: !sparse, stopLossPercent: 1,
            takeProfitEnabled: !sparse, takeProfitPercent: 2 },
        { mode: 'fixed', fixedTradeAmount: 1000 }, undefined,
        { omitEquityCurve: true, includeSharpeRatio: sharpe, skipDrawdown: sparse, requireTradeHistory: true },
    );
    const measure = async (label: string, run: () => unknown | Promise<unknown>, summarizeResult = (value: unknown) => value) => {
        for (let i = 0; i < 3; i++) await run();
        const elapsed: number[] = [];
        let result: unknown;
        for (let i = 0; i < runs; i++) {
            const started = performance.now();
            result = await run();
            elapsed.push(performance.now() - started);
        }
        elapsed.sort((a, b) => a - b);
        return { label, medianMs: elapsed[Math.floor(elapsed.length / 2)], minMs: elapsed[0], maxMs: elapsed.at(-1),
            resultFingerprint: createHash('sha256').update(JSON.stringify(summarizeResult(result))).digest('hex') };
    };
    const cases = [
        await measure('build-30m', () => build()),
        await measure('build-4h-subbars', () => build('4h')),
        await measure('signals-true-range-skew', generate),
        await measure('signals-cold-window', () => strategy.execute(dataset.slice(), strategy.defaultParams)),
        await measure('simulation-next-open-sharpe', () => simulate('next_open', true), value => summarize(value as BacktestResult)),
        await measure('simulation-signal-close', () => simulate('signal_close', false), value => summarize(value as BacktestResult)),
        await measure('simulation-sparse', () => simulate('next_open', false, true), value => summarize(value as BacktestResult)),
        await measure('strategy-plus-simulation', () => {
            const generated = generate();
            return runBacktestCompact(dataset, generated, 10000, 10, 0.1,
                { executionModel: 'next_open', tradeDirection: 'long', slippageBps: 5, maxOpenTrades: 1,
                    riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 1, takeProfitEnabled: true, takeProfitPercent: 2 },
                { mode: 'fixed', fixedTradeAmount: 1000 }, undefined,
                { omitEquityCurve: true, includeSharpeRatio: true, requireTradeHistory: true });
        }, value => summarize(value as BacktestResult)),
        await measure('build-signals-simulation-cold', async () => {
            const fresh = (await build()).bars;
            return runBacktestCompact(fresh, strategy.execute(fresh, strategy.defaultParams), 10000, 10, 0.1,
                { executionModel: 'next_open', tradeDirection: 'long', slippageBps: 5, maxOpenTrades: 1,
                    riskMode: 'percentage', stopLossEnabled: true, stopLossPercent: 1, takeProfitEnabled: true, takeProfitPercent: 2 },
                { mode: 'fixed', fixedTradeAmount: 1000 }, undefined,
                { omitEquityCurve: true, includeSharpeRatio: true, requireTradeHistory: true });
        }, value => summarize(value as BacktestResult)),
    ];
    const closeFast = simulate('signal_close', false);
    assert.deepEqual(summarize(closeFast), summarize(closeReference), 'Fast and fallback results differ');
    const comparisons: { label: string; baselineMedianMs: number; medianMs: number; speedup: number; resultsMatch: boolean }[] = [];
    const comparePath = option('compare', '');
    if (comparePath) {
        const baseline = JSON.parse(readFileSync(comparePath, 'utf8')) as { barCount: number; signals: number; cases: typeof cases };
        assert.equal(baseline.barCount, barCount, 'Baseline bar count differs');
        assert.equal(baseline.signals, signals.length, 'Baseline signal count differs');
        for (const result of cases) {
            const previous = baseline.cases.find(row => row.label === result.label);
            assert.ok(previous, `Baseline is missing ${result.label}`);
            assert.equal(result.resultFingerprint, previous.resultFingerprint, `Results changed for ${result.label}`);
            comparisons.push({ label: result.label, baselineMedianMs: previous.medianMs, medianMs: result.medianMs,
                speedup: previous.medianMs / result.medianMs, resultsMatch: true });
        }
    }
    const report = { node: process.version, barCount, signals: signals.length, runs, cases, comparisons };
    const output = option('out', 'artifacts/equal-weight-performance.json');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
