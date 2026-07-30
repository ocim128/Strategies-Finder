import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildRankPairsCacheDelta,
    formatRankPairsPerformanceDiagnostics,
    type RankPairsPerformanceDiagnostics,
} from "../lib/rank-pairs/rank-pairs-performance";

describe("rank-pairs performance diagnostics", () => {
    it("reports phase shares, throughput, bars, and cache deltas", () => {
        const diagnostics: RankPairsPerformanceDiagnostics = {
            totalPairs: 100,
            processedPairs: 80,
            renderedPairs: 80,
            totalBars: 12_345,
            elapsedMs: 2_000,
            timingsMs: {
                parseInput: 10,
                prepareRelationships: 10,
                load: 1_000,
                classify: 300,
                liveRender: 100,
                progress: 50,
                yield: 200,
                sort: 20,
                finalRender: 100,
            },
            cacheDelta: {
                legHits: 120,
                legMisses: 40,
                pairHits: 5,
                pairMisses: 75,
            },
        };
        const output = formatRankPairsPerformanceDiagnostics(diagnostics);
        expect(output).to.include("40.0 pairs/s");
        expect(output).to.include("shown 80/80");
        expect(output).to.include("12,345 bars");
        expect(output).to.include("load 1.00s (50.0%)");
        expect(output).to.include("cache leg 120H/40M");
        expect(output).to.include("pair 5H/75M");
    });

    it("subtracts cache snapshots so repeated runs show per-run activity", () => {
        const delta = buildRankPairsCacheDelta(
            {
                leg: { hits: 10, misses: 5, size: 4, max: 24 },
                pair: { hits: 3, misses: 9, size: 6, max: 16 },
                disk: { hits: 0, misses: 0, writes: 0 },
            },
            {
                leg: { hits: 18, misses: 7, size: 5, max: 24 },
                pair: { hits: 7, misses: 14, size: 8, max: 16 },
                disk: { hits: 0, misses: 0, writes: 0 },
            },
        );
        expect(delta).to.deep.equal({
            legHits: 8,
            legMisses: 2,
            pairHits: 4,
            pairMisses: 5,
        });
    });
});
