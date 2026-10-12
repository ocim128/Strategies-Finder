/**
 * Shared numeric/formatting helpers for the `analyze-asset-opportunity-*`
 * scripts.
 *
 * These are intentionally NOT `lib/statistics-utils.ts`: the scripts rely on
 * `NaN` for empty inputs (the lib returns `0`) and on nearest-rank percentile
 * (the lib interpolates). The seeded RNG is likewise a different generator from
 * `lib/param-math-utils.ts:createSeededRandom` (this one wraps the state with
 * `| 0`). Keep them separate — unifying would change script output.
 */

/** Parse a comma-separated list of positive integers, deduped and ascending. */
export function parseList(value: string | undefined, fallback: number[]): number[] {
    if (!value) return fallback;
    const parsed = value.split(",").map((item) => Math.floor(Number(item.trim()))).filter((item) => Number.isFinite(item) && item >= 1);
    return parsed.length > 0 ? [...new Set(parsed)].sort((left, right) => left - right) : fallback;
}

/** Deterministic 32-bit seeded RNG (mulberry32 variant) returning [0, 1). */
export function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Arithmetic mean, or `NaN` for an empty sample. */
export function mean(values: number[]): number {
    return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile. `fraction` is in [0, 1]; empty input yields `NaN`. */
export function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[index]!;
}

/** Signed percentage with 2 decimals, or `n/a` for non-finite input. */
export function formatDelta(value: number): string {
    return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a";
}

/** A rate in [0, 1] rendered as a 1-decimal percentage, or `n/a` when non-finite. */
export function formatRate(value: number): string {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}
