import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { waitFor } from "./helpers/wait-for";
import { withTimeout } from "./helpers/with-timeout";
import { createFakeFinderElement } from "./helpers/fake-finder-manager-dom";
import { createFakeBatchElement } from "./helpers/fake-batch-backtest-dom";

describe("operation deadlines", () => {
    it("fails a hung operation at its deadline with the supplied diagnostic", async context => {
        context.mock.timers.enable({ apis: ["setTimeout"] });
        const result = withTimeout(new Promise<never>(() => {}), 15_000, "worker did not settle");
        const rejected = assert.rejects(result, /worker did not settle/);
        context.mock.timers.tick(15_000);
        await rejected;
    });

    it("lets a process exit after resolved and rejected operations without waiting for deadlines", () => {
        const esnoCli = createRequire(import.meta.url).resolve("esno/esno.js");
        const script = `
            const assert = require('node:assert/strict');
            const { withTimeout } = require('./tests/helpers/with-timeout.ts');
            (async () => {
                assert.equal(await withTimeout(Promise.resolve(7), 60000, 'late success'), 7);
                const failure = new Error('original failure');
                await assert.rejects(withTimeout(Promise.reject(failure), 60000, 'late failure'), error => error === failure);
                console.log('settled');
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `;
        const result = spawnSync(process.execPath, [esnoCli, "-e", script], {
            cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 10_000,
        });
        assert.equal(result.error, undefined, "settled deadlines must not keep the child alive");
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "settled");
    });
});

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
