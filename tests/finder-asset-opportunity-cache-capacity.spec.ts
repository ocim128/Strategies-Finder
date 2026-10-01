import { expect } from "chai";
import { describe, it } from "node:test";
import {
    createServerFinderAssetOpportunityLoadContext,
    resolveAssetOpportunityPairCacheCapacity,
} from "../lib/finder/server/server-finder-data-loader";

const GIB = 1024 * 1024 * 1024;

describe("Finder Asset Opportunity pair-cache capacity", () => {
    it("reserves the signal-cache budget before sizing a large worker partition", () => {
        // floor((75% of 8 GiB - 64 MiB) / 10 MiB per symbol)
        expect(resolveAssetOpportunityPairCacheCapacity(679, 8 * GIB)).to.equal(608);
    });

    it("keeps the pair cache within the same reserve-aware budget on smaller hosts", () => {
        // floor((75% of 4 GiB - 64 MiB) / 10 MiB per symbol)
        expect(resolveAssetOpportunityPairCacheCapacity(679, 4 * GIB)).to.equal(300);
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
