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

export const BATCH_BENCHMARK_SCHEMA = "batch.benchmark.v2" as const;

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
    /**
     * Benchmark rows classification (audit benchmark-rows finding). The legacy
     * `loaded`/`failed` pair could not distinguish a cancelled tail from a
     * completed run: cancelled slots were materialized as `no_trades` and
     * counted as loaded, inflating throughput numbers on a fast Stop.
     *
     * `attempted` is the total row count; `completed` are rows where the
     * strategy actually ran (profitable/losing/flat/no_trades); `failed` are
     * load_failed+run_failed; `cancelled` (= `skipped`) are slots never
     * attempted because the loop broke on Stop. `outcome` records the terminal
     * state: a benchmark is recorded only after a known terminal outcome so
     * `incomplete` (HTTP/stream failure before any terminal) is surfaced as
     * such rather than presented as a successful run.
     */
    attempted: number;
    completed: number;
    cancelled: number;
    skipped: number;
    outcome: BatchBenchmarkRunOutcome;
}

export type BatchBenchmarkRunOutcome = "done" | "cancelled" | "fatal" | "incomplete";

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

    // Dominant phase. With only the run phase present, surface it when it
    // exceeded a meaningful duration.
    if (phases.run && phases.run.totalMs > 0) {
        notes.push(`run phase ${phases.run.totalMs.toFixed(0)} ms`);
    }

    if (notes.length === 0) {
        notes.push("No single phase or cache layer exceeded its threshold");
    }
    return notes.slice(0, 4);
}
