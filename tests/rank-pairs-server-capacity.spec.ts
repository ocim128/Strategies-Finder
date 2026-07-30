import { expect } from "chai";
import { describe, it } from "node:test";
import {
    resolveRankPairsLoadConcurrency,
    resolveRankPairsRecentLegCacheEntries,
} from "../lib/rank-pairs/server/rank-pairs-server-capacity";

describe("rank-pairs server capacity", () => {
    it("uses 48 async loaders on a 24-core host", () => {
        expect(resolveRankPairsLoadConcurrency(15_658, null, 24)).to.equal(48);
    });

    it("caps loaders by pair count and the explicit safety maximum", () => {
        expect(resolveRankPairsLoadConcurrency(7, null, 24)).to.equal(7);
        expect(resolveRankPairsLoadConcurrency(1_000, 500, 24)).to.equal(64);
    });

    it("uses a 2,048-entry recent-leg cache on a 64 GiB host", () => {
        expect(resolveRankPairsRecentLegCacheEntries(null, 64 * 1024 ** 3))
            .to.equal(2_048);
    });

    it("allows a bounded environment override for controlled benchmarks", () => {
        expect(resolveRankPairsRecentLegCacheEntries(4_096, 8 * 1024 ** 3))
            .to.equal(4_096);
        expect(resolveRankPairsRecentLegCacheEntries(100_000, 8 * 1024 ** 3))
            .to.equal(8_192);
    });
});
