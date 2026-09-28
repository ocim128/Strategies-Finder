import { expect } from "chai";
import { describe, it } from "node:test";
import {
    createServerFinderAssetOpportunityLoadContext,
    resolveAssetOpportunityPairCacheCapacity,
} from "../lib/finder/server/server-finder-data-loader";
import {
    ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL,
} from "../lib/finder/server/finder-asset-opportunity-capacity";
import { ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES } from "../lib/finder/finder-asset-opportunity-search-cache";

const GIB = 1024 * 1024 * 1024;
const MEMORY_BUDGET_FRACTION = 0.75;

/**
 * Expectations derive from the exported budget constants (dataset +
 * prepared-reference footprint per symbol, minus the worker signal reserve)
 * instead of hard-coded pair counts, so the spec tracks the budget model
 * rather than drifting stale when the constants change.
 */
function expectedDatasetCeiling(systemMemoryBytes: number): number {
    const budget = Math.max(1, Math.floor(systemMemoryBytes * MEMORY_BUDGET_FRACTION))
        - ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES;
    return Math.floor(Math.max(1, budget) / ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL);
}

describe("Finder Asset Opportunity pair-cache capacity", () => {
    it("retains a 679-pair worker partition when the existing memory budget allows it", () => {
        // 32 GiB comfortably covers 679 × 10 MiB of dataset footprint plus
        // the worker signal reserve.
        expect(resolveAssetOpportunityPairCacheCapacity(679, 32 * GIB)).to.equal(679);
        // At 8 GiB the documented budget model bounds the cache below the
        // partition size (per-symbol footprint includes the prepared
        // closed-candle reference array).
        expect(resolveAssetOpportunityPairCacheCapacity(679, 8 * GIB))
            .to.equal(Math.min(679, Math.max(1, expectedDatasetCeiling(8 * GIB))));
    });

    it("keeps the pair cache bounded by the existing memory budget", () => {
        const capacity = resolveAssetOpportunityPairCacheCapacity(679, 4 * GIB);
        expect(capacity).to.equal(Math.min(679, Math.max(1, expectedDatasetCeiling(4 * GIB))));
        expect(capacity, "a 4 GiB budget must not retain the full 679-pair partition").to.be.lessThan(679);
        expect(capacity).to.be.at.least(1);
    });

    it("normalizes an empty worker partition to one cache entry", () => {
        expect(resolveAssetOpportunityPairCacheCapacity(0, 8 * GIB)).to.equal(1);
    });

    it("wires the run-aware capacity into the actual pair cache", () => {
        const context = createServerFinderAssetOpportunityLoadContext(679);
        const expectedCapacity = resolveAssetOpportunityPairCacheCapacity(679);
        for (let index = 0; index <= expectedCapacity; index += 1) {
            context.pairCache!.set(`pair-${index}`, Promise.resolve([]));
        }
        expect(context.pairCache!.size).to.equal(expectedCapacity);
    });
});
