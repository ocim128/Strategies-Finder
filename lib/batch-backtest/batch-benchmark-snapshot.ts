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
}

export interface BatchBenchmarkMinePhase {
    totalMs: number;
    targets: number;
    verdicts: number;
}

export interface BatchBenchmarkStabilityPhase {
    totalMs: number;
    reruns: number;
    subsetSize: number;
    targets: number;
    verdicts: number;
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

    // Stability amplification: each rerun rebuilds per-pair indices from
    // scratch today. A high reruns × subsetSize product relative to run total
    // signals the Stability hot path is the bottleneck.
    if (phases.stability && phases.run && phases.run.totalMs > 0) {
        const stabilityRatio = phases.stability.totalMs / phases.run.totalMs;
        if (stabilityRatio >= 2) {
            notes.push(
                `stability mine took ${stabilityRatio.toFixed(1)}x the run phase (${phases.stability.totalMs.toFixed(0)} ms / ${phases.run.totalMs.toFixed(0)} ms) — index rebuild across reruns is the suspected cost`,
            );
        }
    }

    if (notes.length === 0) {
        notes.push("No single phase or cache layer exceeded its threshold");
    }
    return notes.slice(0, 4);
}
