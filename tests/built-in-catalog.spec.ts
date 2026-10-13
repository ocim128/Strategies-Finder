import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Strategy } from "../lib/types/strategies";
import {
    ensureBuiltInStrategyLoaded,
    isBuiltInStrategyLoaded,
    unregisterLoadedBuiltInStrategy,
} from "../lib/strategies/built-in-catalog";
import { builtInStrategyLoaders } from "../lib/strategies/manifest-loaders";

const TEST_KEY = "__catalog_transient_failure_fixture__";

function fixtureStrategy(name: string): Strategy {
    return {
        name,
        description: "built-in catalog lazy-load fixture",
        defaultParams: {},
        paramLabels: {},
        execute: () => [],
    } as unknown as Strategy;
}

describe("built-in catalog lazy loading", () => {
    afterEach(() => {
        delete builtInStrategyLoaders[TEST_KEY];
        unregisterLoadedBuiltInStrategy(TEST_KEY);
    });

    it("retries the loader after a transient load failure", async () => {
        let attempts = 0;
        builtInStrategyLoaders[TEST_KEY] = async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("simulated transient chunk-load failure");
            }
            return fixtureStrategy("retry fixture");
        };

        await assert.rejects(
            ensureBuiltInStrategyLoaded(TEST_KEY),
            /simulated transient chunk-load failure/,
        );
        assert.equal(isBuiltInStrategyLoaded(TEST_KEY), false);

        const strategy = await ensureBuiltInStrategyLoaded(TEST_KEY);
        assert.equal(attempts, 2);
        assert.equal(strategy?.name, "retry fixture");
        assert.equal(isBuiltInStrategyLoaded(TEST_KEY), true);
    });

    it("shares a single in-flight load across concurrent callers", async () => {
        let attempts = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        builtInStrategyLoaders[TEST_KEY] = async () => {
            attempts += 1;
            await gate;
            return fixtureStrategy("shared fixture");
        };

        const pending = Promise.all([
            ensureBuiltInStrategyLoaded(TEST_KEY),
            ensureBuiltInStrategyLoaded(TEST_KEY),
        ]);
        release();
        const [first, second] = await pending;

        assert.equal(attempts, 1);
        assert.equal(first?.name, "shared fixture");
        assert.equal(second?.name, "shared fixture");
    });

    it("clears a failed shared load so later callers retry", async () => {
        let attempts = 0;
        builtInStrategyLoaders[TEST_KEY] = async () => {
            attempts += 1;
            throw new Error(`load failed on attempt ${attempts}`);
        };

        const settled = await Promise.allSettled([
            ensureBuiltInStrategyLoaded(TEST_KEY),
            ensureBuiltInStrategyLoaded(TEST_KEY),
        ]);

        assert.equal(settled.every(result => result.status === "rejected"), true);
        assert.equal(attempts, 1);
        assert.equal(isBuiltInStrategyLoaded(TEST_KEY), false);

        builtInStrategyLoaders[TEST_KEY] = async () => fixtureStrategy("recovered fixture");
        const strategy = await ensureBuiltInStrategyLoaded(TEST_KEY);
        assert.equal(strategy?.name, "recovered fixture");
        assert.equal(isBuiltInStrategyLoaded(TEST_KEY), true);
    });
});
