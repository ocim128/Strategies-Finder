/** Offline local-data fidelity/resource benchmark. Never fetches or changes template membership. */
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import assert from "node:assert/strict";
import { builtInStrategyKeys } from "../lib/strategies/manifest-keys";
import { canonicalizeLegIdentity } from "../lib/synthetic-leg-identity";
import { TopRawScanEngine } from "../lib/batch-backtest/top-raw-scan-engine";
import { ScanStore, scanFileRevision, scanHash } from "../lib/batch-backtest/top-raw-scan-store";
import { ScanWorkerPool } from "../lib/batch-backtest/top-raw-scan-pool";
import { parseScanAssets, type ScanRequest, type ScanVote, type ScanPair } from "../lib/batch-backtest/top-raw-scan-contract";
import { chooseScanFinalists, createScanPopulation, planScanDiscovery, planScanRefinement, reduceScanDiscovery, reduceScanFinalists } from "../lib/batch-backtest/top-raw-scan-sampling";

const args = process.argv.slice(2);
function arg(name: string, fallback: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1]! : fallback; }
async function main() {
    const size = Number(arg("--size", "8")), workers = Number(arg("--workers", "4"));
    if (!Number.isInteger(size) || size < 2 || size > 500 || !Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error("Use --size 2..500 and --workers 1..32.");
    const seeds = arg("--seeds", "1,7,29").split(",").map(Number);
    const strategies = arg("--strategies", "dema_confirmation,rolling_median_confirmation").split(",");
    const offsets = arg("--offsets", "0,2592000").split(",").map(Number);
    if (seeds.some(seed => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) || offsets.some(offset => !Number.isInteger(offset) || offset < 0)) throw new Error("Seeds must be uint32 integers; offsets must be nonnegative integer seconds.");
    if (!strategies.length || strategies.some(key => !builtInStrategyKeys.includes(key))) throw new Error("Use registered built-in strategy keys.");
    const root = process.cwd(), out = resolve(arg("--out", `artifacts/top-raw-scan-bench/${Date.now()}`));
    await mkdir(out, { recursive: true });
    const template = JSON.parse(await readFile("lib/batch-backtest/batch-symbol-templates.json", "utf8"));
    const assets = parseScanAssets(template.sp500).assets.slice(0, size);
    const request: ScanRequest = { runId: `bench_raw_${Date.now()}`, strategyKey: strategies[0]!, strategyParams: { lookback: 20 }, backtestSettings: { tradeDirection: "both", executionModel: "next_open", disableSignalExits: false, maxOpenTrades: 1, slippageBps: 0 }, capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0.1, sizingMode: "fixed", fixedTradeAmount: 1000 }, interval: "4h", assetListText: assets.join("\n"), opponentsPerAsset: 64, finalistCount: 20, seed: seeds[0]!, workerCount: workers, useRustEnginePreference: false };
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, logicalCores: cpus().length, totalMemoryBytes: totalmem(), requestedSize: size, workers, seeds, strategies, offsets, request };
    let peakRss = process.memoryUsage().rss;
    const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    const started = performance.now();
    try {
        console.log(`Fast scan: ${size} requested assets, ${workers} workers.`);
        const engine = new TopRawScanEngine(request);
        let lastPhase = "";
        const fast = await engine.run(status => { if (status.phase !== lastPhase) { lastPhase = status.phase; console.log(`${status.phase}: ${status.completed}/${status.total} ${status.message}`); } });
        report.fast = fast;
        report.fastWallMs = performance.now() - started;
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
        if (fast.phase !== "completed") throw new Error(`Fast scan failed: ${fast.message}`);
        const result = fast.result!, store = new ScanStore(root), manifest = (await store.readManifest(request.runId))!;
        let artifactBytes = (await stat(store.path(request.runId, "manifest.json"))).size + (await stat(store.path(request.runId, "result.json"))).size;
        for (const index of manifest.completedShards) artifactBytes += (await stat(store.path(request.runId, `shard-${index}.json`))).size;
        report.fastArtifactBytes = artifactBytes;
        report.fastPeakRssBytes = peakRss;
        const universe = result.eligibleAssets, fidelity: unknown[] = [];
        const population = createScanPopulation(universe, seeds[0]!);
        const full: ScanPair[] = [];
        for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) full.push(population.pair(universe[i]!, universe[j]!));
        // These are intentionally exhaustive small/SP500 references, never the large-list scheduler path.
        const pool = new ScanWorkerPool();
        await pool.initialize(workers);
        try {
            for (const strategyKey of args.includes("--large-only") ? [] : strategies) for (const offset of offsets) {
                // Historical endpoints come from the same normalized source at/before the requested cutoff.
                let commonTimes: Set<number> | undefined;
                for (const asset of universe) {
                    const times = await pool.task<number[]>(0, { type: "preflight", asset, interval: request.interval, cutoff: result.asOf - offset + 14400 });
                    const present = new Set(times);
                    commonTimes = commonTimes === undefined ? present : new Set([...commonTimes].filter(time => present.has(time)));
                }
                assert.ok(commonTimes?.size, "No common historical endpoint for the frozen universe");
                const endpoint = Math.max(...commonTimes);
                if (!offset) assert.equal(endpoint, result.asOf);
                const config = { ...request, strategyKey }, votesBySymbol = new Map<string, ScanVote>();
                const phaseMs: number[] = [], engineUsage = { rust: 0, typescript: 0 };
                for (const reverse of [false, true]) {
                    let next = 0;
                    const stageStart = performance.now();
                    await Promise.all(Array.from({ length: pool.size }, async (_, slot) => {
                        while (next < full.length) {
                            const begin = next; next += 32;
                            const pairs = full.slice(begin, begin + 32).map(p => reverse ? { ...p, base: p.quote, quote: p.base, symbol: `${p.quote}+${p.base}` } : p);
                            const votes = await pool.task<ScanVote[]>(slot, { type: "pairs", pairs, request: config, asOf: endpoint, cutoff: endpoint + 14400, sources: manifest.sources.filter(s => s.asset === "catalog" || pairs.some(p => p.base === s.asset || p.quote === s.asset)), engineIdentity: "typescript_only" });
                            assert.equal(votes.length, pairs.length, "Incomplete reference shard");
                            assert.ok(votes.every(vote => !vote.error), `Reference coverage failed: ${votes.find(vote => vote.error)?.error}`);
                            for (let i = 0; i < votes.length; i++) { const vote = votes[i]!; votesBySymbol.set(pairs[i]!.symbol, vote); if (!vote.error) engineUsage[vote.engine]++; }
                            if (begin % 10000 < 32) console.log(`${strategyKey} E=${endpoint} ${reverse ? "reverse" : "reference"}: ${Math.min(next, full.length)}/${full.length}`);
                        }
                    }));
                    phaseMs.push(performance.now() - stageStart);
                }
                for (const source of manifest.sources) assert.equal(await scanFileRevision(source.path), source.revision, `source changed: ${source.asset}`);
                const errors = [...votesBySymbol.values()].filter(v => v.error);
                const coverage = { successful: votesBySymbol.size - errors.length, failed: errors.length, failureExamples: errors.slice(0, 10) };
                assert.equal(errors.length, 0, "Incomplete reference cannot establish recall or exact parity");
                const comparisons: unknown[] = [];
                for (const seed of seeds) {
                    const pop = createScanPopulation(universe, seed), votes = new Map<string, ScanVote>(), exact = new Map(universe.map(asset => [asset, 0]));
                    for (let i = 0; i < universe.length; i++) for (let j = i + 1; j < universe.length; j++) {
                        const pair = pop.pair(universe[i]!, universe[j]!), vote = votesBySymbol.get(pair.symbol)!; votes.set(pair.key, vote);
                        if (!vote.error) { exact.set(pair.base, exact.get(pair.base)! + vote.vote); exact.set(pair.quote, exact.get(pair.quote)! - vote.vote); }
                    }
                    const options = { seed, opponentsPerAsset: 64, finalistCount: 20 }, sampled = planScanDiscovery(universe, options);
                    const discovery = reduceScanDiscovery(universe, sampled, votes), selection = chooseScanFinalists(discovery, Math.min(20, universe.length), seed);
                    const verified = reduceScanFinalists(universe, selection.selected, seed, votes);
                    let exactParity = true;
                    for (const row of verified) if (row.complete && row.exactRaw !== exact.get(row.asset)) exactParity = false;
                    assert.ok(exactParity, "Incorrect exact finalist score");
                    if (strategyKey === request.strategyKey && offset === 0 && seed === request.seed) for (const row of result.finalists) assert.equal(row.exactRaw, exact.get(row.asset), "Engine finalist differs from exhaustive reference");
                    const exactRows = discovery.map(row => ({ ...row, estimatedRaw: exact.get(row.asset)! }));
                    const exhaustiveOrder = chooseScanFinalists(exactRows, universe.length, seed).selected;
                    const estimatedOrder = chooseScanFinalists(discovery, universe.length, seed).selected;
                    const best = Math.max(...exact.values()), winners = [...exact].filter(([, score]) => score === best).map(([asset]) => asset);
                    const bestFinal = Math.max(...verified.filter(r => r.complete).map(r => r.exactRaw!));
                    comparisons.push({ seed, coverageComplete: !errors.length, discoveryPairs: sampled.length, refinementPairs: planScanRefinement(universe, selection.selected, seed, new Set(sampled.map(p => p.key))).length, recall: Object.fromEntries([1, 5, 20].map(k => { const n = Math.min(k, universe.length); return [`top${k}`, exhaustiveOrder.slice(0, n).filter(asset => estimatedOrder.slice(0, n).includes(asset)).length / n]; })), exhaustiveWinnerInFinalists: winners.some(asset => selection.selected.includes(asset)), winnerTieCount: winners.length, cutoffTieCount: selection.cutoffTies.length, omittedCutoffTies: selection.omittedCutoffTies.length, exactFinalistParity: exactParity, scoreGap: Number.isFinite(bestFinal) ? best - bestFinal : null, bestScore: best, bestFinalistScore: Number.isFinite(bestFinal) ? bestFinal : null, exactTop20: exhaustiveOrder.slice(0, 20), estimatedTop20: estimatedOrder.slice(0, 20) });
                }
                fidelity.push({ strategyKey, strategyParams: config.strategyParams, endpoint, populationSize: universe.length, sourceFingerprint: scanHash(result.sourceRevisions), configurationFingerprint: scanHash({ config, endpoint, sourceRevisions: result.sourceRevisions }), referencePairsPerOrientation: full.length, bothOrientations: true, phaseMs, engineUsage, coverage, comparisons });
                report.fidelity = fidelity; report.peakRssBytes = peakRss;
                await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
            }
        } finally { await pool.dispose(); }
        const scheduling = [];
        for (const n of [3000, 5000]) {
            const virtual = Array.from({ length: n }, (_, index) => `VIRTUAL${index}•`), start = performance.now();
            const pairs = planScanDiscovery(virtual, { seed: 1, opponentsPerAsset: 64, finalistCount: 20 });
            const refinement = planScanRefinement(virtual, virtual.slice(0, 20), 1, new Set(pairs.map(p => p.key)));
            scheduling.push({ type: "synthetic_scheduler_only", assets: n, discoveryPairs: pairs.length, refinementPairs: refinement.length, wallMs: performance.now() - start, rssBytes: process.memoryUsage().rss });
        }
        report.scheduling = scheduling;
        if (args.includes("--large")) {
            const catalog = JSON.parse(await readFile("price-data/ibkr/catalog.json", "utf8"));
            const entries = (Array.isArray(catalog.entries) ? catalog.entries : Object.values(catalog.entries)) as Array<{ symbol: string; intervals?: Record<string, { bars?: number; lastTime?: string }> }>;
            // Target 4h candles are reconstructed from 30m seeds; the catalog need
            // not contain a separately stored 4h interval. Preflight checks bars.
            // Prefer the most recent histories, but disclose the actual common
            // endpoint rather than imposing an arbitrary freshness exclusion.
            const candidates = entries.filter(entry => canonicalizeLegIdentity(`${entry.symbol}•`)?.provider === "ibkr" && (entry.intervals?.["30m"]?.bars ?? 0) >= 200)
                .sort((a, b) => (Date.parse(b.intervals?.["30m"]?.lastTime ?? "") || 0) - (Date.parse(a.intervals?.["30m"]?.lastTime ?? "") || 0) || a.symbol.localeCompare(b.symbol))
                .map(entry => `${entry.symbol}•`);
            const largeRuns: unknown[] = [];
            report.largeRuns = largeRuns;
            // A benchmark fixture may be selected from the archive. Find genuine
            // shared target-bar coverage before constructing its explicit input;
            // the production scan still validates and freezes that entire list.
            const windows: Array<{ asset: string; times: Set<number> }> = [], counts = new Map<number, number>();
            if (candidates.length >= 3000) {
                const selectionPool = new ScanWorkerPool();
                await selectionPool.initialize(workers);
                try {
                    const cutoff = Math.floor(Date.now() / 1000);
                    for (const asset of candidates) {
                        try {
                            const times = new Set((await selectionPool.task<number[]>(0, { type: "preflight", asset, interval: request.interval, cutoff })).slice(199));
                            windows.push({ asset, times });
                            for (const time of times) counts.set(time, (counts.get(time) ?? 0) + 1);
                        } catch { /* Unavailable histories cannot enter the benchmark fixture. */ }
                    }
                } finally { await selectionPool.dispose(); }
            }
            const maxEligibleAssets = Math.max(0, ...counts.values());
            // Also measure the largest feasible archive fixture when it falls
            // just below 3,000, without relabeling it as a 3,000-asset execution.
            const sizes = [3000, 5000, ...(maxEligibleAssets >= 500 && maxEligibleAssets < 3000 ? [maxEligibleAssets] : [])];
            for (const n of sizes) {
                if (candidates.length < n) { largeRuns.push({ requestedAssets: n, availableCatalogAssets: candidates.length, reason: "Insufficient eligible catalog fixtures for execution; scheduler measured separately." }); continue; }
                const endpoint = [...counts].filter(([, count]) => count >= n).sort((a, b) => b[0] - a[0])[0]?.[0];
                if (endpoint === undefined) { largeRuns.push({ requestedAssets: n, availableCatalogAssets: candidates.length, maxEligibleAssets, reason: "No common target endpoint with at least 200 closed bars supports this fixture; scheduler measured separately." }); continue; }
                const selected = windows.filter(window => window.times.has(endpoint)).slice(0, n).map(window => window.asset);
                const config = { ...request, runId: `${request.runId}_large_${n}`, assetListText: selected.join("\n") };
                let runPeak = process.memoryUsage().rss;
                const timer = setInterval(() => { runPeak = Math.max(runPeak, process.memoryUsage().rss); }, 100);
                const scan = new TopRawScanEngine(config);
                let phase = "";
                try {
                    const runStart = performance.now();
                    const status = await scan.run(value => { if (value.phase !== phase || value.completed % 10000 < 32) { phase = value.phase; console.log(`Large ${n}: ${value.phase} ${value.completed}/${value.total}`); } });
                    const wallMs = performance.now() - runStart;
                    const saved = await store.readManifest(config.runId);
                    let bytes = 0;
                    if (saved) {
                        for (const name of ["manifest.json", "result.json", ...saved.completedShards.map(index => `shard-${index}.json`)]) bytes += (await stat(store.path(config.runId, name))).size;
                    }
                    largeRuns.push({ requestedAssets: n, universe: "local_catalog_common_target_200bars_recent_first", fixtureSelection: { endpoint, maxEligibleAssets, catalogCandidates: candidates.length }, phase: status.phase, message: status.message, eligibleAssets: status.result?.eligibleAssets.length, exclusions: status.result?.exclusions, asOf: status.result?.asOf, fingerprint: status.result?.fingerprint, pairCounts: status.result?.pairCounts, timings: status.result?.timings, wallMs, engineUsage: status.result?.engineUsage, artifactBytes: bytes, peakRssBytes: runPeak });
                } finally { clearInterval(timer); }
                report.largeRuns = largeRuns;
                await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
            }
        }
        let stopAt = 0;
        const stoppedEngine = new TopRawScanEngine({ ...request, runId: request.runId + "_stop" });
        const stopped = await stoppedEngine.run(status => { if (!stopAt && status.phase === "discovery" && status.completed > 0) { stopAt = performance.now(); stoppedEngine.stop(); } });
        report.stop = { phase: stopped.phase, latencyMs: stopAt ? performance.now() - stopAt : null };
        report.totalWallMs = performance.now() - started; report.peakRssBytes = peakRss;
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
        console.log(`Benchmark saved: ${out}; source ${scanHash(result.sourceRevisions)}; peak RSS ${(peakRss / 1024 ** 3).toFixed(2)} GiB.`);
    } catch (error) {
        report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); report.totalWallMs = performance.now() - started; report.peakRssBytes = peakRss;
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
        throw error;
    } finally { clearInterval(memoryTimer); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
