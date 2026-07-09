/**
 * Asset-to-pair and subset indexes shared by the TypeScript miner and the Rust
 * request builders (Phase 1 + Phase 4 acceleration).
 *
 * This is a leaf module: it imports only types from `batch-synthetic-state-miner`,
 * never `lightweight-charts` or any browser-bound singleton. That keeps it safe
 * to import from `worker_threads` and from the Vite config bundle path (see the
 * "Server-side import hygiene" note in AGENTS.md).
 *
 * Why this exists: `buildAssetVerdict(...)` previously called
 * `pairs.filter((pair) => pair.baseAsset === target.asset || pair.quoteAsset === target.asset)`
 * once per target. On a 1000-pair / 80-asset Stability rerun that is
 * 80 × 1000 = 80,000 string comparisons per rerun, × 50 reruns = 4,000,000.
 * Indexing once per prepared-pair set collapses each lookup to O(1).
 */

import type { BatchSyntheticPreparedPairArtifact } from "./batch-synthetic-state-miner";

/**
 * Map of normalized asset name -> indexes into the prepared-pair array. Built
 * once from a prepared-pair set and reused across every target in one run.
 *
 * Indexes (not pair references) are stored so the index stays valid when the
 * caller slices the pair array for a Stability subset: rebuild from the subset.
 */
export type PairsByAssetIndex = ReadonlyMap<string, readonly number[]>;

/**
 * Build an asset -> pair-index lookup from a prepared-pair set. Each pair
 * contributes its base and quote asset. Assets are normalized to upper-case
 * trimmed form to match `normalizeAsset(...)` in the miner.
 */
export function buildPairsByAssetIndex(
    pairs: readonly BatchSyntheticPreparedPairArtifact[],
): PairsByAssetIndex {
    const index = new Map<string, number[]>();
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
        const pair = pairs[pairIndex]!;
        const base = normalizeAsset(pair.baseAsset);
        const quote = normalizeAsset(pair.quoteAsset);
        appendIndex(index, base, pairIndex);
        // A pair whose base === quote (degenerate) should not double-count;
        // prepareBatchSyntheticPairArtifacts already drops those, but guard
        // anyway so the index never carries a duplicate for one pair.
        if (quote !== base) {
            appendIndex(index, quote, pairIndex);
        }
    }
    const frozen = new Map<string, readonly number[]>();
    for (const [key, list] of index) {
        frozen.set(key, Object.freeze(list.slice()));
    }
    return frozen;
}

/**
 * Resolve the linked pair indexes for one target asset. Returns a frozen
 * (deduplicated, ascending) list of indexes into the source pair array.
 *
 * Caller is expected to bump `assetIndexHits` / `assetIndexMisses` on the miner
 * profile — this helper is pure so it can be unit-tested without a profile.
 */
export function resolveLinkedPairIndexes(
    index: PairsByAssetIndex,
    asset: string,
): readonly number[] {
    const key = normalizeAsset(asset);
    const hits = index.get(key);
    return hits ?? EMPTY;
}

const EMPTY: readonly number[] = Object.freeze([] as number[]);

function appendIndex(index: Map<string, number[]>, asset: string, pairIndex: number): void {
    if (!asset) return;
    const list = index.get(asset);
    if (list) {
        list.push(pairIndex);
    } else {
        index.set(asset, [pairIndex]);
    }
}

function normalizeAsset(value: string): string {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}
