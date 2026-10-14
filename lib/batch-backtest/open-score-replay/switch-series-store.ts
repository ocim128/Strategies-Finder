/**
 * Run-scoped compact series store for the asset-switch replay stage.
 *
 * The switch stage's `SwitchTargetLookup` extracts per-target
 * `times/opens/closes` Float64Arrays from every loaded dataset. Those arrays
 * are derived from data already trimmed at the run cutoff, so they are
 * window-INDEPENDENT — every replay pass (full window + each annual window)
 * queries the same series. Historically each pass built a fresh lookup with a
 * small per-pass point budget, so a 2,800-symbol S&P universe (~155M points at
 * 30m) evicted continuously WITHIN a pass and was re-normalized from scratch
 * (an O(bars) pass) on every pass — measured 23k dataset loads in the
 * full-window pass alone and ~47.5k across a 17-window run.
 *
 * This store holds those compact arrays once per RUN, bounded by a point
 * budget sized from machine RAM (see {@link resolveSwitchSeriesCacheLimits});
 * lookups on later passes become cache hits that skip both the dataset load
 * and the re-normalization. Per-pass bookkeeping (requested/loaded/coverage,
 * per-lookup hit/miss counters, per-window lookup results) stays in the
 * per-pass `SwitchTargetLookup`.
 *
 * Leaf-safe: imports only `node:os`. Imported by `types.ts` (type-only) and
 * the coordinator.
 */
import { totalmem } from "node:os";

export interface CandleGapInterval {
    from: number;
    to: number;
}

export interface SwitchSeriesMeta {
    status: "ok" | "missing" | "invalid";
    gaps: CandleGapInterval[];
    times?: Float64Array;
    opens?: Float64Array;
    closes?: Float64Array;
}

export interface SwitchSeriesCacheLimits {
    entries: number;
    points: number;
}

/** Point-budget tiers for the shared store (three Float64Arrays per point). */
export const SWITCH_SERIES_STORE_POINT_TIERS = [
    { minTotalMemoryBytes: 48 * 1024 ** 3, points: 192_000_000 },
    { minTotalMemoryBytes: 24 * 1024 ** 3, points: 64_000_000 },
] as const;

/** Floor matching the historical per-pass budget for small hosts. */
export const SWITCH_SERIES_STORE_MIN_POINTS = 8_000_000;
export const SWITCH_SERIES_STORE_MIN_ENTRIES = 8_192;

export function seriesPointCount(meta: SwitchSeriesMeta | undefined): number {
    return meta?.status === "ok" ? meta.times?.length ?? 0 : 0;
}

/**
 * Cache limits for one run's shared series store. `targetAssetCount` is the
 * run's distinct replay-target universe, so the entry bound never evicts
 * before the point budget does; the point budget tiers with machine RAM
 * because each retained point costs three Float64 slots (~24 B). The budget
 * only bounds growth — an unused slot costs nothing.
 */
export function resolveSwitchSeriesCacheLimits(
    targetAssetCount: number,
    totalMemoryBytes = totalmem(),
): SwitchSeriesCacheLimits {
    let points = SWITCH_SERIES_STORE_MIN_POINTS as number;
    for (const tier of SWITCH_SERIES_STORE_POINT_TIERS) {
        if (totalMemoryBytes >= tier.minTotalMemoryBytes) {
            points = tier.points;
            break;
        }
    }
    return {
        entries: Math.max(SWITCH_SERIES_STORE_MIN_ENTRIES, targetAssetCount + 64),
        points,
    };
}

export interface SwitchSeriesStoreStats {
    entries: number;
    points: number;
    peakPoints: number;
    evictions: number;
}

export class SwitchSeriesStore {
    private readonly seriesMeta = new Map<string, SwitchSeriesMeta>();
    private seriesMetaPoints = 0;
    private seriesPeakPoints = 0;
    private seriesEvictions = 0;

    constructor(private readonly limits: SwitchSeriesCacheLimits) {}

    get(asset: string): SwitchSeriesMeta | undefined {
        const meta = this.seriesMeta.get(asset);
        if (meta) {
            // LRU refresh so a re-requested series is not the next eviction.
            this.seriesMeta.delete(asset);
            this.seriesMeta.set(asset, meta);
        }
        return meta;
    }

    remember(asset: string, meta: SwitchSeriesMeta): void {
        const previous = this.seriesMeta.get(asset);
        if (previous) {
            this.seriesMeta.delete(asset);
            this.seriesMetaPoints -= seriesPointCount(previous);
        }
        this.seriesMeta.set(asset, meta);
        this.seriesMetaPoints += seriesPointCount(meta);
        while (this.seriesMeta.size > this.limits.entries || this.seriesMetaPoints > this.limits.points) {
            const oldestAsset = this.seriesMeta.keys().next().value;
            if (oldestAsset === undefined) break;
            const oldest = this.seriesMeta.get(oldestAsset)!;
            this.seriesMeta.delete(oldestAsset);
            this.seriesMetaPoints -= seriesPointCount(oldest);
            this.seriesEvictions += 1;
        }
        this.seriesPeakPoints = Math.max(this.seriesPeakPoints, this.seriesMetaPoints);
    }

    get stats(): SwitchSeriesStoreStats {
        return {
            entries: this.seriesMeta.size,
            points: this.seriesMetaPoints,
            peakPoints: this.seriesPeakPoints,
            evictions: this.seriesEvictions,
        };
    }
}
