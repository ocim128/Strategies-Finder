import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planPolymarketEventSync } from "../lib/polymarket-sync-utils";

describe("Polymarket sync planner", () => {
    it("fetches only missing events by default", () => {
        const events = [
            { slug: "a" },
            { slug: "b" },
            { slug: "c" },
        ];

        const plan = planPolymarketEventSync(events, new Set(["a", "c"]));

        assert.deepEqual(plan.toFetch.map((event) => event.slug), ["b"]);
        assert.equal(plan.missing, 1);
        assert.equal(plan.skippedExisting, 2);
        assert.equal(plan.refreshedExisting, 0);
    });

    it("can refresh the most recent existing events while still fetching missing ones", () => {
        const events = [
            { slug: "a" },
            { slug: "b" },
            { slug: "c" },
            { slug: "d" },
        ];

        const plan = planPolymarketEventSync(events, new Set(["a", "c", "d"]), 2);

        assert.deepEqual(plan.toFetch.map((event) => event.slug), ["b", "c", "d"]);
        assert.equal(plan.missing, 1);
        assert.equal(plan.skippedExisting, 1);
        assert.equal(plan.refreshedExisting, 2);
    });
});
