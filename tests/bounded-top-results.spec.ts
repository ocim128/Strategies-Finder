import assert from "node:assert/strict";
import { it } from "node:test";
import { BoundedTopResults } from "../lib/bounded-top-results";

it("matches full stable ranking while retaining only the requested number of results", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
        index, score: (index * 7919) % 101, secondary: index % 7, fullResult: { trades: [index] },
    }));
    const compare = (a: typeof rows[number], b: typeof rows[number]) =>
        b.score - a.score || b.secondary - a.secondary || a.index - b.index;
    for (const limit of [1, 3, 100, 1000, 6000]) {
        const ranked = new BoundedTopResults(limit, compare);
        for (const row of rows) {
            ranked.offer(row);
            assert.ok(ranked.size <= limit, "discarded result graphs must not remain retained");
        }
        assert.deepEqual(ranked.toSortedArray(), [...rows].sort(compare).slice(0, limit));
    }
});
