import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readAlertWorkerUrl, writeAlertWorkerUrl } from "../lib/alert-storage";
import {
    readLivePositionsCollapsed,
    readLivePositionsEnabled,
    writeLivePositionsCollapsed,
    writeLivePositionsEnabled,
} from "../lib/live-positions-storage";

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

describe("simple localStorage wrappers", () => {
    it("normalizes alert worker URLs and tolerates unavailable storage", () => {
        const values = new Map<string, string>();
        installLocalStorage({
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
        });

        assert.equal(writeAlertWorkerUrl("https://alerts.example.com///"), "https://alerts.example.com");
        assert.equal(readAlertWorkerUrl(), "https://alerts.example.com");

        installLocalStorage({
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        });

        assert.equal(readAlertWorkerUrl(), "");
        assert.doesNotThrow(() => writeAlertWorkerUrl("https://alerts.example.com/"));
    });

    it("returns safe live-position defaults when storage throws", () => {
        installLocalStorage({
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        });

        assert.equal(readLivePositionsCollapsed(), false);
        assert.equal(readLivePositionsEnabled(), false);
        assert.doesNotThrow(() => writeLivePositionsCollapsed(true));
        assert.doesNotThrow(() => writeLivePositionsEnabled(true));
    });
});
