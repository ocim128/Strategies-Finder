/**
 * Phase 1 benchmark harness (docs/finder-arm-performance-worker-reuse-plan.md):
 * measures the runner's existing enableWorkerReuse path — one sweep-scoped
 * TopMeanWorkerPool lent to every sequential candidate — against the default
 * candidate-owned pools, on identical plans / pairs / cutoff / settings.
 *
 * Results are written as JSON under artifacts/arm-worker-reuse-bench/. Run the
 * same command twice with --reuse false and --reuse true and compare
 * resultHash (must match exactly) plus wallMs / spawnedWorkers / loadMs /
 * cache counters / peak memory.
 *
 * This is a measurement harness only — no lib code paths change.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
    buildFinderArmPerformanceCandidatePlans,
    runFinderArmPerformance,
    type FinderArmPerformanceCoordinator,
    type FinderArmPerformanceRunnerInput,
} from "../lib/finder/finder-arm-performance-runner";
import {
    TopMeanCoordinatorEngine,
    type TopMeanCoordinatorEngineDeps,
    type TopMeanCoordinatorRunRequest,
    type TopMeanStatusResponse,
} from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import { enumerateSp500Pairs } from "../lib/batch-backtest/sp500-pair-enumerator";
import { getServerBatchDatasetCacheStats } from "../lib/batch-backtest/server-batch-data-loader";
import { resolveBacktestSettingsFromRaw } from "../lib/backtest-settings-resolver";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import type { BacktestSettings } from "../lib/types/strategies";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";

interface BenchArgs {
    pairs: number;
    candidates: number;
    reuse: boolean;
    rust: boolean;
    horizon: number;
    cutoff: number;
    label: string;
    seed: number;
    workers: number;
}

function parseArgs(argv: readonly string[]): BenchArgs {
    const args: BenchArgs = {
        pairs: 50,
        candidates: 3,
        reuse: false,
        rust: false,
        horizon: 5,
        cutoff: 1_900_000_000,
        label: `bench-${Date.now()}`,
        seed: 20260927,
        workers: 4,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]!;
        const value = argv[i + 1];
        const take = (): string => {
            if (value === undefined) throw new Error(`Missing value for ${flag}`);
            i += 1;
            return value;
        };
        switch (flag) {
            case "--pairs": args.pairs = Number(take()); break;
            case "--candidates": args.candidates = Number(take()); break;
            case "--reuse": args.reuse = take() === "true"; break;
            case "--rust": args.rust = take() === "true"; break;
            case "--horizon": args.horizon = Number(take()); break;
            case "--cutoff": args.cutoff = Number(take()); break;
            case "--label": args.label = take(); break;
            case "--seed": args.seed = Number(take()); break;
            case "--workers": args.workers = Number(take()); break;
            default: throw new Error(`Unknown flag ${flag}`);
        }
    }
    return args;
}

function fail(message: string): never {
    console.error(`BENCH FAIL: ${message}`);
    process.exit(1);
}

function listSeedSymbols(seedDir: string): string[] {
    if (!fs.existsSync(seedDir)) fail(`30m seed dir not found: ${seedDir}`);
    return fs.readdirSync(seedDir)
        .filter((name) => name.endsWith(".csv") && !name.endsWith(".bak.csv"))
        .map((name) => name.slice(0, -".csv".length))
        .filter((symbol) => (fs.statSync(path.join(seedDir, `${symbol}.csv`)).size >= 500_000))
        .sort();
}

function buildPairListText(symbols: readonly string[], pairCount: number): string {
    const tokens: string[] = [];
    if (symbols.length >= pairCount * 2) {
        for (let i = 0; i < pairCount; i += 1) {
            tokens.push(`${symbols[i]}\u2022+${symbols[i + pairCount]}\u2022`);
        }
        return tokens.join("\n");
    }
    // Not enough symbols for disjoint pairs: reuse each symbol once as a base
    // and once as a quote (deterministic mirror construction) so a large-pair
    // sweep stays feasible on fixture universes with < 2N seeds.
    if (pairCount > symbols.length) {
        fail(`Need at least ${pairCount} seed symbols for ${pairCount} pairs; found ${symbols.length}.`);
    }
    for (let i = 0; i < pairCount; i += 1) {
        const quote = symbols[(i + Math.floor(symbols.length / 2)) % symbols.length]!;
        tokens.push(`${symbols[i]}\u2022+${quote}\u2022`);
    }
    return tokens.join("\n");
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    console.log(`[bench] cwd=${cwd} pairs=${args.pairs} candidates=${args.candidates} reuse=${args.reuse} rust=${args.rust}`);

    const symbols = listSeedSymbols(path.join(cwd, "price-data", "ibkr", "csv", "30m"));
    const pairListText = buildPairListText(symbols, args.pairs);
    const enumeration = enumerateSp500Pairs({ interval: "4h", pairListText });
    if (enumeration.canonicalPairs.length === 0) {
        fail("Enumeration produced zero canonical pairs — check price-data fixtures.");
    }
    console.log(`[bench] canonical pairs: ${enumeration.canonicalPairs.length} (requested ${args.pairs})`);

    const strategy = await loadBuiltInStrategyByKey("ema_confirmation");
    if (!strategy) fail("ema_confirmation strategy failed to load.");
    const selectedStrategies = [{ key: "ema_confirmation", name: strategy.name, strategy }];

    const settings: BacktestSettings = resolveBacktestSettingsFromRaw({
        executionModel: "signal_close",
        tradeDirection: "long",
        allowSameBarExit: true,
        slippageBps: 0,
        marketMode: "all",
    } as BacktestSettings, { coerceWithoutUiToggles: true });
    const capitalSettings: CapitalSettings = {
        initialCapital: 10000,
        positionSize: 100,
        commission: 0,
        sizingMode: "percent",
        fixedTradeAmount: 1000,
    };
    const options = {
        mode: "random",
        scope: "arm_performance",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        topN: 10,
        steps: 3,
        rangePercent: 100,
        maxRuns: args.candidates,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        freezeRiskManagement: true,
        randomSeed: args.seed,
        dataSlice: "all",
        armPerformance: { horizon: args.horizon, dateMode: "full" },
    } as unknown as FinderOptions;

    const plans = buildFinderArmPerformanceCandidatePlans({
        selectedStrategies,
        exitStrategyCandidates: [],
        settings,
        options,
    });
    if (plans.length === 0) fail("Plan generation produced zero candidates.");
    console.log(`[bench] plans: ${plans.length}`);

    // Capture each child's final status (via the coordinator seam) so the
    // pool's own performance diagnostics — spawnedWorkers, workerStartupMs,
    // loadMs, cache counters — are recorded per candidate without touching
    // the runner.
    const perCandidate: Array<Record<string, unknown>> = [];
    let lastStatus: TopMeanStatusResponse | null = null;
    let candidateStartedAt = 0;
    const createCoordinator = (
        request: TopMeanCoordinatorRunRequest,
        baseDir: string,
        deps: TopMeanCoordinatorEngineDeps,
    ): FinderArmPerformanceCoordinator => {
        const engine = new TopMeanCoordinatorEngine(request, baseDir, deps);
        return {
            request,
            run: ((emit: (event: unknown) => void) => engine.run(emit)) as FinderArmPerformanceCoordinator["run"],
            stop: () => engine.stop(),
            waitForTeardown: () => engine.waitForTeardown(),
            getStatus: () => {
                const status = engine.getStatus();
                lastStatus = status;
                return status;
            },
            getFailedPairDetails: () => engine.getFailedPairDetails(),
        };
    };

    const input: FinderArmPerformanceRunnerInput = {
        runId: `bench_arm_${args.label.replace(/[^a-zA-Z0-9_-]/g, "")}`,
        interval: "4h",
        options,
        settings,
        capitalSettings,
        useRustEnginePreference: args.rust,
        evaluationCutoffSec: args.cutoff,
        enumeration,
        selectedStrategies,
        exitStrategyCandidates: [],
        baseDir: cwd,
        signal: new AbortController().signal,
        isCancelled: () => false,
        plans,
        workerCount: args.workers,
        ...(args.reuse ? { enableWorkerReuse: true } : {}),
    };

    let peakRssBytes = 0;
    let peakExternalBytes = 0;
    const sampler = setInterval(() => {
        const memory = process.memoryUsage();
        if (memory.rss > peakRssBytes) peakRssBytes = memory.rss;
        const externalish = (memory.external ?? 0) + (memory.arrayBuffers ?? 0);
        if (externalish > peakExternalBytes) peakExternalBytes = externalish;
    }, 200);

    const staleRunDir = path.join(cwd, "artifacts", "sp500-top-mean");
    if (fs.existsSync(staleRunDir)) {
        for (const entry of fs.readdirSync(staleRunDir)) {
            if (entry.startsWith(`finder_arm_${input.runId.slice("bench_arm_".length)}`)) {
                fs.rmSync(path.join(staleRunDir, entry), { recursive: true, force: true });
            }
        }
    }

    const cacheStatsBefore = getServerBatchDatasetCacheStats();
    const sweepStartedAt = performance.now();
    const candidates = await runFinderArmPerformance(input, {
        onProgress: () => {},
        onPairFailures: (failures) => {
            for (const failure of failures) {
                console.log(`[bench] PAIR FAIL ${failure.symbol}: ${failure.error}`);
            }
        },
        onCandidate: (candidate) => {
            const performance_ = lastStatus?.performance;
            perCandidate.push({
                candidateOrdinal: candidate.candidateOrdinal,
                candidateId: candidate.candidateId,
                wallMs: performance.now() - candidateStartedAt,
                actualEngineMode: candidate.actualEngineMode,
                pairCoverage: candidate.pairCoverage,
                metrics: candidate.metrics,
                worker: performance_?.worker,
                phases: performance_?.phases,
                engine: performance_?.engine,
            });
            const worker = performance_?.worker;
            console.log(
                `[bench] candidate ${candidate.candidateOrdinal} done: wall=${(performance.now() - candidateStartedAt).toFixed(0)}ms`
                + ` spawned=${worker?.spawnedWorkers ?? "?"} startup=${worker?.workerStartupMs?.toFixed(0) ?? "?"}ms`
                + ` load=${worker?.loadMs?.toFixed(0) ?? "?"}ms backtest=${worker?.backtestMs?.toFixed(0) ?? "?"}ms`
                + ` cache leg=${worker?.cache.legHits ?? "?"}h/${worker?.cache.legMisses ?? "?"}m pair=${worker?.cache.pairHits ?? "?"}h/${worker?.cache.pairMisses ?? "?"}m`,
            );
        },
        setActiveCoordinator: () => {},
    }, { createCoordinator });
    clearInterval(sampler);
    const sweepWallMs = performance.now() - sweepStartedAt;

    // Parity fingerprint over the DETERMINISTIC fields only: events, topMean
    // (the fixed arm-selection metric), coverage, and the winning params.
    // randomMean/delta are the stochastic uniform-random control baseline and
    // vary per invocation by float epsilon (~1e-16 relative) whether or not
    // reuse is on — they are excluded on both sides, not smoothed.
    const parityPayload = JSON.stringify(candidates.map((candidate) => ({
        candidateOrdinal: candidate.candidateOrdinal,
        strategyKey: candidate.strategyKey,
        params: candidate.params,
        horizon: candidate.horizon,
        pairCoverage: candidate.pairCoverage,
        metrics: Object.fromEntries(Object.entries(candidate.metrics).map(([arm, comparison]) => [arm, {
            events: comparison.events,
            topMean: comparison.topMean,
        }])),
    })));
    const resultHash = createHash("sha256").update(parityPayload).digest("hex");

    const report = {
        label: args.label,
        reuse: args.reuse,
        rust: args.rust,
        pairs: enumeration.canonicalPairs.length,
        candidates: candidates.length,
        horizon: args.horizon,
        seed: args.seed,
        cutoffSec: args.cutoff,
        sweepWallMs,
        resultHash,
        peakRssBytes,
        peakExternalBytes,
        mainThreadCacheStatsAfter: getServerBatchDatasetCacheStats(),
        mainThreadCacheStatsBefore: cacheStatsBefore,
        perCandidate,
    };
    const outDir = path.join(cwd, "artifacts", "arm-worker-reuse-bench");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${args.label}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[bench] sweep wall=${sweepWallMs.toFixed(0)}ms hash=${resultHash.slice(0, 12)} peakRssMB=${(peakRssBytes / 1024 / 1024).toFixed(0)} peakExtMB=${(peakExternalBytes / 1024 / 1024).toFixed(0)}`);
    console.log(`[bench] report: ${outPath}`);
}

main().catch((error: unknown) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
