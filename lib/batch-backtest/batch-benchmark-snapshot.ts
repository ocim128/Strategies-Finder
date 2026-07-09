/**
 * Benchmark snapshot for Batch Backtest runs.
 *
 * Mirrors the shape of Finder's `CompactFinderDiagnostics`
 * (`lib/finder/finder-diagnostics.ts`): a versioned JSON document with a
 * `schema` tag, top-level context, per-phase timings, and auto-derived
 * bottleneck strings. Pretty-printed via `JSON.stringify(..., null, 2)` and
 * copied to the clipboard, exactly like Finder's Copy Diagnostics button.
 *
 * Captured at the service layer — no `performance.now()` instrumentation
 * inside the runner loop. Phase totals are wall-clock from the caller's POV.
 * Cache stats come from `BatchDatasetLoaderCore.getCacheStats()` and reflect
 * the in-memory LRU + (server-side) disk cache for synthetic pairs.
 */

import type { BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import type { BatchMinerEngine, BatchSyntheticMinerProfile } from "./batch-synthetic-state-miner";

export const BATCH_BENCHMARK_SCHEMA = "batch.benchmark.v1" as const;

export interface BatchBenchmarkCacheBucket {
    hits: number;
    misses: number;
    /** hits / (hits + misses); 0 when no traffic. */
    hitRate: number;
}

export interface BatchBenchmarkCacheStats {
    syntheticLeg: BatchBenchmarkCacheBucket & { size: number; max: number };
    syntheticPair: BatchBenchmarkCacheBucket & { size: number; max: number };
    /** Disk cache only populated in server-side mode. */
    disk: BatchBenchmarkCacheBucket & { writes: number };
}

export type BatchBenchmarkCacheSource = "browser_loader" | "server_stream" | "unavailable";

export interface BatchBenchmarkRunPhase {
    totalMs: number;
    loaded: number;
    failed: number;
    synthetic: number;
    real: number;
    avgMsPerLoaded: number | null;
}

export interface BatchBenchmarkMinePhase {
    totalMs: number;
    targets: number;
    verdicts: number;
    avgMsPerTarget: number | null;
    avgMsPerVerdict: number | null;
}

export interface BatchBenchmarkStabilityPhase {
    totalMs: number;
    reruns: number;
    subsetSize: number;
    totalPairs: number;
    sampledPairEvaluations: number;
    targetAssets: number;
    targets: number;
    verdicts: number;
    hitEvents: number;
    avgMsPerRerun: number | null;
    avgMsPerSampledPair: number | null;
    hitEventsPerRerun: number | null;
    hitEventsPerSampledPair: number | null;
    minerProfile: BatchSyntheticMinerProfile | null;
    /**
     * Which miner engine actually ran (Phase 6 reporting). `typescript` is the
     * sequential reference; `typescript_parallel` is the Node worker path. Null
     * when no Stability ran (so the field is informational, not load-bearing).
     */
    engine: BatchMinerEngine | null;
}

export interface BatchBenchmarkSnapshot {
    schema: typeof BATCH_BENCHMARK_SCHEMA;
    run: {
        mode: "browser" | "server";
        strategy: string;
        interval: string;
        engineMode: string;
        executedAt: string;
    };
    cacheSource: BatchBenchmarkCacheSource;
    phases: {
        run: BatchBenchmarkRunPhase | null;
        mine: BatchBenchmarkMinePhase | null;
        stability: BatchBenchmarkStabilityPhase | null;
    };
    cache: BatchBenchmarkCacheStats;
    bottlenecks: string[];
}

function rate(hits: number, misses: number): number {
    const total = hits + misses;
    return total > 0 ? Number((hits / total).toFixed(4)) : 0;
}

export function benchmarkRatio(numerator: number, denominator: number, decimals = 2): number | null {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return null;
    }
    return Number((numerator / denominator).toFixed(decimals));
}

function largestMinerSubphase(profile: BatchSyntheticMinerProfile | null): { name: string; ms: number } | null {
    if (!profile) return null;
    const candidates: Array<[string, number]> = [
        ["prepare pairs", profile.preparePairsMs],
        ["linked pair filter", profile.linkedPairFilterMs],
        ["horizon selection", profile.horizonMs],
        ["current snapshot", profile.currentSnapshotMs],
        ["candidate samples", profile.candidateSamplesMs],
        ["windowing", profile.windowingMs],
        ["distance scale", profile.distanceScaleMs],
        ["analog selection", profile.analogSelectionMs],
        ["summaries", profile.summarizeMs],
        ["pair contributions", profile.pairContributionsMs],
        ["classification", profile.classifyMs],
        // Server-side artifact load/deserialize cost.
        ["artifact conversion", profile.artifactConversionMs],
    ];
    const valid = candidates
        .filter(([, ms]) => Number.isFinite(ms) && ms > 0)
        .sort((a, b) => b[1] - a[1]);
    const top = valid[0];
    return top ? { name: top[0], ms: top[1] } : null;
}

function parallelWallEquivalent(ms: number, profile: BatchSyntheticMinerProfile | null, engine: string | null): number {
    if (engine !== "typescript_parallel" || !profile) return ms;
    const workers = Math.max(1, Math.floor(profile.parallelWorkerCount || 0));
    return workers > 1 ? ms / workers : ms;
}

export function buildCacheStatsFromLoader(stats: BatchDatasetCacheStats): BatchBenchmarkCacheStats {
    return {
        syntheticLeg: {
            hits: stats.leg.hits,
            misses: stats.leg.misses,
            hitRate: rate(stats.leg.hits, stats.leg.misses),
            size: stats.leg.size,
            max: stats.leg.max,
        },
        syntheticPair: {
            hits: stats.pair.hits,
            misses: stats.pair.misses,
            hitRate: rate(stats.pair.hits, stats.pair.misses),
            size: stats.pair.size,
            max: stats.pair.max,
        },
        disk: {
            hits: stats.disk.hits,
            misses: stats.disk.misses,
            hitRate: rate(stats.disk.hits, stats.disk.misses),
            writes: stats.disk.writes,
        },
    };
}

/**
 * Auto-derived bottleneck strings (2-4 max). Each rule fires at most once and
 * only when its threshold is crossed. Mirror's Finder's `buildFinderDiagnosticsBottlenecks`
 * intent: short human-readable notes that point at the likely culprit.
 */
export function buildBatchBenchmarkBottlenecks(
    phases: BatchBenchmarkSnapshot["phases"],
    cache: BatchBenchmarkCacheStats,
    cacheSource: BatchBenchmarkCacheSource = "browser_loader",
): string[] {
    const notes: string[] = [];

    if (cacheSource === "unavailable") {
        notes.push("server cache counters unavailable; restart the dev server so the Batch plugin can stream cacheStats");
    }

    // Leg cache hit rate. With a fully-crossed N-symbol universe, the same
    // legs are reused across many pairs; a low rate signals the cap is too
    // small for the universe size.
    if (cache.syntheticLeg.misses > cache.syntheticLeg.max * 2 && cache.syntheticLeg.hitRate < 0.3) {
        notes.push(
            `synthetic leg cache hit rate ${(cache.syntheticLeg.hitRate * 100).toFixed(1)}% ` +
            `(${cache.syntheticLeg.hits} hits / ${cache.syntheticLeg.misses} misses) — cap ${cache.syntheticLeg.max} may be too low for this universe`,
        );
    }

    // Disk cache hit rate (server mode only — both counters stay 0 in browser).
    if ((cache.disk.hits + cache.disk.misses) > 0 && cache.disk.hitRate < 0.5 && cache.disk.misses > 10) {
        notes.push(
            `synthetic disk cache hit rate ${(cache.disk.hitRate * 100).toFixed(1)}% ` +
            `(${cache.disk.hits} hits / ${cache.disk.misses} misses) — first run for these pairs or seeds changed`,
        );
    }

    // Dominant phase. Whichever phase has the largest totalMs and exceeds 60%
    // of the sum of all observed phase totals.
    const observed: Array<[string, number]> = [];
    if (phases.run) observed.push(["run", phases.run.totalMs]);
    if (phases.mine) observed.push(["mine", phases.mine.totalMs]);
    if (phases.stability) observed.push(["stability", phases.stability.totalMs]);
    const totalObserved = observed.reduce((sum, [, ms]) => sum + ms, 0);
    if (totalObserved > 0) {
        observed.sort((a, b) => b[1] - a[1]);
        const [domName, domMs] = observed[0];
        const pct = domMs / totalObserved;
        if (pct >= 0.6) {
            notes.push(
                `${domName} phase dominated (${(pct * 100).toFixed(1)}% of observed wall clock, ${domMs.toFixed(0)} ms)`,
            );
        }
    }

    // Stability amplification: each rerun reevaluates a sampled prepared pair
    // subset. A high reruns x subsetSize product relative to run total signals
    // the Stability hot path is the bottleneck.
    if (phases.stability && phases.run && phases.run.totalMs > 0) {
        const stabilityRatio = phases.stability.totalMs / phases.run.totalMs;
        if (stabilityRatio >= 2) {
            const workload = phases.stability.sampledPairEvaluations > 0
                ? `; workload ${phases.stability.sampledPairEvaluations} sampled pair-reruns`
                : "";
            const avgRerun = phases.stability.avgMsPerRerun !== null
                ? `; avg ${phases.stability.avgMsPerRerun.toFixed(0)} ms/rerun`
                : "";
            const avgPair = phases.stability.avgMsPerSampledPair !== null
                ? `, ${phases.stability.avgMsPerSampledPair.toFixed(2)} ms/sampled pair`
                : "";
            const topSubphase = largestMinerSubphase(phases.stability.minerProfile);
            const profileNote = topSubphase
                ? `; top miner subphase ${topSubphase.name} ${topSubphase.ms.toFixed(0)} ms`
                : "";
            notes.push(
                `stability mine took ${stabilityRatio.toFixed(1)}x the run phase (${phases.stability.totalMs.toFixed(0)} ms / ${phases.run.totalMs.toFixed(0)} ms)${workload}${avgRerun}${avgPair}${profileNote} - inspect phases.stability.minerProfile for the exact split`,
            );
        }
    }

    // Engine / fallback reporting (Phase 6). Surface which miner engine ran
    // and — when Rust was attempted but fell back — why. This is diagnostic-
    // only: it never blocks the run, it just makes "why didn't Rust kick in"
    // answerable from the benchmark without server logs.
    // Artifact load/deserialize cost. On the sequential path this is the
    // one-time artifact load; on the parallel path it is summed across workers
    // and includes each worker's disk read/deserialization of the sampled
    // artifact subset, so normalize by worker count before comparing to
    // wall-clock Stability time.
    if (phases.stability && phases.stability.minerProfile && phases.stability.totalMs > 0) {
        const convMs = phases.stability.minerProfile.artifactConversionMs;
        if (Number.isFinite(convMs) && convMs > 0) {
            const comparableMs = parallelWallEquivalent(convMs, phases.stability.minerProfile, phases.stability.engine);
            const convPct = comparableMs / phases.stability.totalMs;
            if (convPct >= 0.2) {
                const rawNote = comparableMs !== convMs
                    ? `, summed worker CPU ${convMs.toFixed(0)} ms`
                    : "";
                notes.push(
                    `artifact load/conversion was ${(convPct * 100).toFixed(1)}% of stability (${comparableMs.toFixed(0)} ms wall-equivalent${rawNote}) - reduce worker duplicate loads`,
                );
            }
        }
    }

    if (phases.stability?.engine === "typescript_parallel" && phases.stability.minerProfile && phases.stability.totalMs > 0) {
        const topSubphase = largestMinerSubphase(phases.stability.minerProfile);
        if (topSubphase) {
            const comparableMs = parallelWallEquivalent(topSubphase.ms, phases.stability.minerProfile, phases.stability.engine);
            if (comparableMs / phases.stability.totalMs >= 0.35) {
                notes.push(
                    `parallel worker CPU is dominated by ${topSubphase.name} (${topSubphase.ms.toFixed(0)} ms summed, ~${comparableMs.toFixed(0)} ms wall-equivalent)`,
                );
            }
        }
    }

    if (notes.length === 0) {
        notes.push("No single phase or cache layer exceeded its threshold");
    }
    return notes.slice(0, 4);
}
