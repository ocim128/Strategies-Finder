/** Repeat a fixed, seeded sample of a copied Finder configuration on local data.
 * Run: npm exec -- esno scripts/bench-finder-entry-time.ts <configuration.json> <label> [symbolCount]
 * This uses the captured exit override; copied UI configurations omit the sampled exit list.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runFinderUniverseExecution } from '../lib/finder/finder-runner-universe';
import { FinderParamSpace } from '../lib/finder/finder-param-space';
import { loadServerFinderDataset } from '../lib/finder/server/server-finder-data-loader';
import { builtInStrategyLoaders } from '../lib/strategies/manifest-loaders';
import type { FinderOptions } from '../lib/types/finder';

async function main() {
    const [path, label, countText = '6'] = process.argv.slice(2);
    if (!path || !label || !/^[a-z0-9-]+$/i.test(label)) throw new Error('Provide configuration path and alphanumeric label.');
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid symbol count.');
    const capture = JSON.parse(readFileSync(path, 'utf8'));
    const f = capture.finder;
    const symbols = f.universeSymbolsText.trim().split(/\s+/).slice(0, count);
    const key = f.universeSelectedStrategyKeys[0];
    const strategy = await builtInStrategyLoaders[key]();
    const options: FinderOptions = {
        ...f, randomSeed: 20261005, sortPriority: [f.sortPrimary, f.sortSecondary],
        maxTrades: Infinity,
        universe: { symbols, minActiveSymbols: f.universeMinActiveSymbols,
            minTotalTrades: f.universeMinTotalTrades, minProfitableActiveRatio: f.universeMinProfitableActiveRatio,
            sortPriority: [f.universeSort, f.universeSortSecondary] },
    };
    const datasets = new Map();
    for (const symbol of symbols) {
        const data = await loadServerFinderDataset(symbol, '4h');
        if (data.length < 10) throw new Error(`No local history for ${symbol}`);
        datasets.set(symbol, data);
    }
    const space = new FinderParamSpace();
    const samples = [];
    for (let i = 0; i < 4; i++) {
        const start = performance.now();
        const output = await runFinderUniverseExecution({
            interval: '4h', options, settings: capture.backtestSettings,
            capitalSettings: capture.capitalSettings, selectedStrategy: { key, name: strategy.name, strategy },
            loadDataset: async symbol => datasets.get(symbol),
            generateParamSets: (defaults, settings) => space.generateParamSets(defaults, settings),
            useRustEnginePreference: true,
        }, { setProgress() {}, setStatus() {}, isCancelled: () => false,
            yieldControl: () => new Promise(resolve => setImmediate(resolve)) });
        const sample = { ms: performance.now() - start, hash: createHash('sha256').update(JSON.stringify(output.results)).digest('hex'),
            candidates: output.results.length, diagnostics: output.diagnostics };
        console.log(JSON.stringify({ iteration: i, ms: sample.ms, candidates: sample.candidates, hash: sample.hash }));
        if (i > 0) samples.push(sample);
    }
    mkdirSync('artifacts/finder-entry-time-bench', { recursive: true });
    writeFileSync(`artifacts/finder-entry-time-bench/${label}.json`, JSON.stringify({ symbols,
        bars: [...datasets.values()].map(data => data.length), options, samples,
        medianMs: samples.map(s => s.ms).sort((a, b) => a - b)[1] }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
