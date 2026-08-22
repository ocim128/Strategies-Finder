import { expect } from "chai";
import { describe, it } from "node:test";
import {
    createServerFinderAssetOpportunityLoadContext,
    resolveAssetOpportunityPairCacheCapacity,
} from "../lib/finder/server/server-finder-data-loader";

const GIB = 1024 * 1024 * 1024;

describe("Finder Asset Opportunity pair-cache capacity", () => {
    it("retains a 679-pair worker partition when the existing memory budget allows it", () => {
        expect(resolveAssetOpportunityPairCacheCapacity(679, 8 * GIB)).to.equal(679);
    });

    it("keeps the pair cache bounded by the existing memory budget", () => {
        expect(resolveAssetOpportunityPairCacheCapacity(679, 4 * GIB)).to.equal(341);
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
