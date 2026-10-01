import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitFor } from "./helpers/wait-for";
import { createFakeFinderElement } from "./helpers/fake-finder-manager-dom";
import { createFakeBatchElement } from "./helpers/fake-batch-backtest-dom";

describe("bounded condition waits", () => {
    it("observes a condition becoming ready", async () => {
        let ready = false;
        const transition = delay(5).then(() => { ready = true; });
        await waitFor(() => ready, 1_000, "ready condition");
        assert.equal(ready, true, "the wait must not return before the transition");
        await transition;
    });

    it("fails with the unmet condition instead of renewing its deadline", { timeout: 1_000 }, async () => {
        await assert.rejects(waitFor(() => false, 15, "queued scan"), /timed out waiting for queued scan/);
    });

    it("accepts an already satisfied condition without waiting", async () => {
        await waitFor(() => true, 0, "ready condition");
    });
});

for (const [name, createElement] of [
    ["Finder", createFakeFinderElement],
    ["Batch", createFakeBatchElement],
] as const) {
    describe(`${name} fake element`, () => {
        it("removes only the matching listener and deduplicates registrations", () => {
            const element = createElement();
            const calls: string[] = [];
            const removed = () => calls.push("removed");
            const retained = () => calls.push("retained");
            element.addEventListener("click", removed);
            element.addEventListener("click", retained);
            element.addEventListener("click", retained);
            element.removeEventListener("click", removed);
            assert.equal(element.click(), true);
            assert.deepEqual(calls, ["retained"]);
            element.removeEventListener("click", retained);
            assert.equal(element.click(), false);
        });

        it("defers listeners added during dispatch and honors removal during dispatch", () => {
            const element = createElement();
            const calls: string[] = [];
            const removed = () => calls.push("removed");
            const added = () => calls.push("added");
            element.addEventListener("click", () => {
                calls.push("first");
                element.removeEventListener("click", removed);
                element.addEventListener("click", added);
            });
            element.addEventListener("click", removed);
            element.click();
            assert.deepEqual(calls, ["first"]);
            element.click();
            assert.deepEqual(calls, ["first", "first", "added"]);
        });

        it("retains replacement children and replaces the old collection", () => {
            const element = createElement();
            const oldChild = { name: "old" };
            const first = { name: "first" };
            const second = { name: "second" };
            element.appendChild(oldChild);
            element.replaceChildren(first, second);
            assert.deepEqual(element.children, [first, second]);
            element.replaceChildren();
            assert.deepEqual(element.children, []);
        });
    });
}
