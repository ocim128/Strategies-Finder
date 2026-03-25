import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "node:test";
import { readPersistedJson, writePersistedJson } from "./lib/persisted-json";

class MemoryStorage implements Storage {
    public length = 0;
    private data = new Map<string, string>();

    clear(): void {
        this.data.clear();
        this.length = 0;
    }

    getItem(key: string): string | null {
        return this.data.has(key) ? this.data.get(key)! : null;
    }

    key(index: number): string | null {
        return Array.from(this.data.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.data.delete(key);
        this.length = this.data.size;
    }

    setItem(key: string, value: string): void {
        this.data.set(key, value);
        this.length = this.data.size;
    }
}

describe("persisted-json", () => {
    const originalStorage = globalThis.localStorage;
    let storage: MemoryStorage;

    beforeEach(() => {
        storage = new MemoryStorage();
        Object.defineProperty(globalThis, "localStorage", {
            value: storage,
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        if (originalStorage === undefined) {
            delete (globalThis as { localStorage?: Storage }).localStorage;
            return;
        }

        Object.defineProperty(globalThis, "localStorage", {
            value: originalStorage,
            configurable: true,
            writable: true,
        });
    });

    it("reads legacy raw payloads through migrate", () => {
        storage.setItem("legacy", JSON.stringify({ value: 42 }));

        const result = readPersistedJson<number>({
            key: "legacy",
            schema: "example",
            version: 2,
            fallback: 0,
            migrate: ({ schema, version, data }) => {
                expect(schema).to.equal(null);
                expect(version).to.equal(null);
                return typeof (data as { value?: unknown }).value === "number"
                    ? (data as { value: number }).value
                    : null;
            },
        });

        expect(result).to.equal(42);
    });

    it("writes and reads versioned envelopes", () => {
        const saved = writePersistedJson({
            key: "current",
            schema: "example",
            version: 3,
            data: { enabled: true },
        });

        expect(saved).to.equal(true);

        const result = readPersistedJson<boolean>({
            key: "current",
            schema: "example",
            version: 3,
            fallback: false,
            migrate: ({ schema, version, data }) => {
                expect(schema).to.equal("example");
                expect(version).to.equal(3);
                return (data as { enabled?: boolean }).enabled === true;
            },
        });

        expect(result).to.equal(true);
    });

    it("returns fallback for schema mismatches", () => {
        storage.setItem("mismatch", JSON.stringify({
            schema: "other",
            version: 1,
            data: { value: 99 },
        }));

        const result = readPersistedJson<number>({
            key: "mismatch",
            schema: "expected",
            version: 1,
            fallback: 7,
            migrate: () => 99,
        });

        expect(result).to.equal(7);
    });
});
