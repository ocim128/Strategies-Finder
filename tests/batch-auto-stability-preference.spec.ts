import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    readBatchAutoRunStability,
    shouldAutoRunBatchStability,
    writeBatchAutoRunStability,
} from "../lib/batch-backtest/batch-auto-stability-preference";

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(storage: Partial<Storage>): void {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: storage,
    });
}

afterEach(() => {
    if (originalLocalStorageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, "localStorage");
    }
});

describe("Batch auto-run Stability preference", () => {
    it("defaults off and remembers the last selection", () => {
        const values = new Map<string, string>();
        installLocalStorage({
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });

        assert.equal(readBatchAutoRunStability(), false);
        assert.equal(writeBatchAutoRunStability(true), true);
        assert.equal(readBatchAutoRunStability(), true);
        assert.equal(writeBatchAutoRunStability(false), true);
        assert.equal(readBatchAutoRunStability(), false);
    });

    it("falls back off when persisted data is invalid or storage is unavailable", () => {
        installLocalStorage({ getItem: () => "not-json" });
        assert.equal(readBatchAutoRunStability(), false);

        installLocalStorage({ getItem: () => { throw new Error("blocked"); } });
        assert.equal(readBatchAutoRunStability(), false);
    });

    it("runs only after a successful Batch completion with mineable artifacts", () => {
        assert.equal(shouldAutoRunBatchStability(true, false, true), true);
        assert.equal(shouldAutoRunBatchStability(false, false, true), false);
        assert.equal(shouldAutoRunBatchStability(true, true, true), false);
        assert.equal(shouldAutoRunBatchStability(true, false, false), false);
    });
});
