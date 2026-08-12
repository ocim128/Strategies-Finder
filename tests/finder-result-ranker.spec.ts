import { expect } from "chai";
import { describe, it } from "node:test";
import { compareFinderResults, sortFinderResults } from "../lib/finder/finder-engine";
import { FinderResultRanker } from "../lib/finder/finder-result-ranker";
import type { FinderResult } from "../lib/types/finder";
import type { BacktestResult } from "../lib/types/strategies";

const SORT_PRIORITY = ["expectancy"] as const;

function makeCandidate(key: string, expectancy: number): FinderResult {
    const result: BacktestResult = {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
    return {
        key,
        name: key,
        params: {},
        result,
        selectionResult: result,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

describe("FinderResultRanker", () => {
    it("retains exactly the best maxSize candidates regardless of offer order", () => {
        const ranker = new FinderResultRanker(3, [...SORT_PRIORITY]);
        // Offer in worst-first order so every offer replaces the heap root.
        for (const candidate of [5, 6, 7, 1, 2, 3, 4].map((value) => makeCandidate(`c${value}`, value))) {
            ranker.offer(candidate);
        }
        const retained = ranker.toSortedArray(3).map((candidate) => candidate.selectionResult.expectancy);
        expect(retained).to.deep.equal([7, 6, 5]);
    });

    it("matches a stable full sort + slice, including ties straddling the boundary", () => {
        const candidates = [
            makeCandidate("a", 1),
            makeCandidate("b", 5),
            makeCandidate("c", 5),
            makeCandidate("d", 5),
            makeCandidate("e", 2),
            makeCandidate("f", 9),
        ];
        const ranker = new FinderResultRanker(3, [...SORT_PRIORITY]);
        for (const candidate of candidates) ranker.offer(candidate);

        const expected = sortFinderResults(candidates, [...SORT_PRIORITY])
            .slice(0, 3)
            .map((candidate) => candidate.key);
        expect(ranker.toSortedArray(3).map((candidate) => candidate.key)).to.deep.equal(expected);
    });

    it("treats values within the comparator epsilon as ties, matching full-sort behavior", () => {
        // compareFinderResults treats |a - b| <= 0.0001 as a tie.
        const candidates = [
            makeCandidate("a", 10),
            makeCandidate("b", 10.00005),
            makeCandidate("c", 9.99995),
            makeCandidate("d", 0),
        ];
        const ranker = new FinderResultRanker(2, [...SORT_PRIORITY]);
        for (const candidate of candidates) ranker.offer(candidate);

        const expected = sortFinderResults(candidates, [...SORT_PRIORITY])
            .slice(0, 2)
            .map((candidate) => candidate.key);
        expect(ranker.toSortedArray(2).map((candidate) => candidate.key)).to.deep.equal(expected);
    });

    it("fires the eviction hook exactly for candidates that leave the retained set", () => {
        const evictedKeys: string[] = [];
        const ranker = new FinderResultRanker(3, [...SORT_PRIORITY], (evicted) => {
            evictedKeys.push(evicted.key);
        });
        const candidates = [
            makeCandidate("a", 1),
            makeCandidate("b", 2),
            makeCandidate("c", 3),
            makeCandidate("d", 4), // evicts a
            makeCandidate("e", 0), // worse than the worst; rejected, no eviction
            makeCandidate("f", 5), // evicts b
        ];
        for (const candidate of candidates) ranker.offer(candidate);

        expect(evictedKeys).to.deep.equal(["a", "b"]);
        const retained = ranker.toSortedArray(3).map((candidate) => candidate.key);
        expect(retained).to.deep.equal(["f", "d", "c"]);
        // Eviction order is deterministic but the hook never fires twice for
        // the same candidate, and never for a retained one.
        expect(new Set(evictedKeys).size).to.equal(evictedKeys.length);
        expect(retained).to.not.include.any.members(evictedKeys);
    });

    it("keeps per-candidate side data pruned to the retained set (IS-search signal pattern)", () => {
        const sideData = new Map<FinderResult, string>();
        const ranker = new FinderResultRanker(3, [...SORT_PRIORITY], (evicted) => {
            sideData.delete(evicted);
        });
        const candidates = [
            makeCandidate("a", 1),
            makeCandidate("b", 2),
            makeCandidate("c", 3),
            makeCandidate("d", 4),
            makeCandidate("e", 0),
        ];
        for (const candidate of candidates) {
            // Mirror the IS-search pattern: attach signals only when the
            // candidate is retained; evictions delete them later.
            const retained = ranker.offer(candidate);
            if (retained) sideData.set(candidate, `signals:${candidate.key}`);
        }
        // The map must contain exactly the retained set (never entries for
        // evicted or rejected candidates), so a top-K lookup cannot miss.
        const retainedKeys = ranker.toSortedArray(3).map((candidate) => candidate.key);
        expect([...sideData.keys()].map((candidate) => candidate.key).sort())
            .to.deep.equal([...retainedKeys].sort());
        for (const candidate of ranker.toSortedArray(3)) {
            expect(sideData.get(candidate)).to.equal(`signals:${candidate.key}`);
        }
        // A rejected candidate never leaves stale side data behind.
        expect(sideData.has(candidates[4]!)).to.equal(false);
    });

    it("uses the same comparator as the stable full sort", () => {
        const a = makeCandidate("a", 1);
        const b = makeCandidate("b", 2);
        const ranker = new FinderResultRanker(1, [...SORT_PRIORITY]);
        ranker.offer(b);
        // a is worse than b (lower expectancy), so it is rejected.
        expect(ranker.offer(a)).to.equal(false);
        expect(compareFinderResults(a, b, [...SORT_PRIORITY])).to.be.greaterThan(0);
        expect(ranker.toSortedArray(1).map((candidate) => candidate.key)).to.deep.equal(["b"]);
    });
});
