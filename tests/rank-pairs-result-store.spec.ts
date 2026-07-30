import { expect } from "chai";
import { after, before, beforeEach, describe, it } from "node:test";
import {
    loadLatestRankPairsResultSnapshot,
    loadRankPairsSnapshotCopyText,
    RANK_PAIRS_RESULT_CHUNK_SIZE,
    saveLatestRankPairsResultSnapshot,
} from "../lib/rank-pairs/rank-pairs-result-store";

type StoredRecord = { key: string } & Record<string, unknown>;

class FakeObjectStore {
    constructor(private readonly records: Map<string, StoredRecord>) {}

    get(key: string) {
        const request = {
            result: undefined as StoredRecord | undefined,
            error: null,
            onsuccess: null as null | (() => void),
            onerror: null as null | (() => void),
        };
        queueMicrotask(() => {
            request.result = structuredClone(this.records.get(key));
            request.onsuccess?.();
        });
        return request;
    }

    put(record: StoredRecord) {
        this.records.set(record.key, structuredClone(record));
    }

    delete(key: string) {
        this.records.delete(key);
    }
}

class FakeTransaction {
    public error: Error | null = null;
    public oncomplete: null | (() => void) = null;
    public onerror: null | (() => void) = null;
    public onabort: null | (() => void) = null;

    constructor(private readonly records: Map<string, StoredRecord>) {
        queueMicrotask(() => this.oncomplete?.());
    }

    objectStore() {
        return new FakeObjectStore(this.records);
    }
}

class FakeDb {
    private readonly stores = new Map<string, Map<string, StoredRecord>>();

    public objectStoreNames = {
        contains: (name: string) => this.stores.has(name),
    };

    createObjectStore(name: string) {
        const records = new Map<string, StoredRecord>();
        this.stores.set(name, records);
        return new FakeObjectStore(records);
    }

    transaction(name: string | string[]) {
        const storeName = Array.isArray(name) ? name[0]! : name;
        const records = this.stores.get(storeName);
        if (!records) throw new Error(`Missing fake object store ${storeName}`);
        return new FakeTransaction(records);
    }

    clear(): void {
        for (const records of this.stores.values()) records.clear();
    }

    keys(name: string): string[] {
        return Array.from(this.stores.get(name)?.keys() ?? []);
    }

    close(): void {}
}

class FakeIndexedDbFactory {
    public readonly db = new FakeDb();
    private upgraded = false;

    open() {
        const shouldUpgrade = !this.upgraded;
        this.upgraded = true;
        const request = {
            result: this.db,
            error: null,
            onupgradeneeded: null as null | (() => void),
            onsuccess: null as null | (() => void),
            onerror: null as null | (() => void),
            onblocked: null as null | (() => void),
        };
        queueMicrotask(() => {
            if (shouldUpgrade) request.onupgradeneeded?.();
            request.onsuccess?.();
        });
        return request;
    }
}

describe("rank-pairs result store", () => {
    const originalIndexedDb = (globalThis as Record<string, unknown>).indexedDB;
    const factory = new FakeIndexedDbFactory();

    before(() => {
        Object.defineProperty(globalThis, "indexedDB", {
            value: factory,
            configurable: true,
            writable: true,
        });
    });

    beforeEach(() => {
        factory.db.clear();
    });

    after(() => {
        Object.defineProperty(globalThis, "indexedDB", {
            value: originalIndexedDb,
            configurable: true,
            writable: true,
        });
    });

    it("stores a 124,000+ row copy result in bounded chunks while metadata retains only the preview", async () => {
        const results = Array.from(
            { length: 124_001 },
            (_, index) => index,
        );
        const saved = await saveLatestRankPairsResultSnapshot({
            mode: "recent200",
            interval: "4h",
            results,
            preview: results.slice(0, 2_000),
            summaryText: "Pairs 124001",
            diagnosticsText: "Perf 1.00s",
            copyPreamble: ["HEADER", "COLUMNS"],
            serializeCopyRow: (result) => `row-${result}`,
        });

        expect(saved.resultCount).to.equal(results.length);
        expect(saved.chunkCount).to.equal(
            Math.ceil(results.length / RANK_PAIRS_RESULT_CHUNK_SIZE),
        );
        expect(saved.preview).to.have.length(2_000);
        expect(saved.preview.slice(0, 3)).to.deep.equal([0, 1, 2]);
        expect(saved).not.to.have.property("results");

        const restored = await loadLatestRankPairsResultSnapshot<number>();
        expect(restored?.resultCount).to.equal(results.length);
        expect(restored?.preview).to.have.length(2_000);
    });

    it("materializes every row only when copy text is requested", async () => {
        const saved = await saveLatestRankPairsResultSnapshot({
            mode: "history",
            interval: "1d",
            results: [3, 2, 1],
            preview: [3],
            summaryText: "Pairs 3",
            diagnosticsText: "Perf 3ms",
            copyPreamble: ["HEADER", "A | B"],
            serializeCopyRow: (result) => `row-${result}`,
        });

        expect(await loadRankPairsSnapshotCopyText(saved)).to.equal(
            "HEADER\nA | B\nrow-3\nrow-2\nrow-1",
        );
    });

    it("replaces the prior generation only after the new snapshot commits", async () => {
        const first = await saveLatestRankPairsResultSnapshot({
            mode: "history",
            interval: "1d",
            results: [1, 2],
            preview: [1],
            summaryText: "first",
            diagnosticsText: "first",
            copyPreamble: ["FIRST"],
            serializeCopyRow: String,
        });
        const second = await saveLatestRankPairsResultSnapshot({
            mode: "history",
            interval: "1d",
            results: [9],
            preview: [9],
            summaryText: "second",
            diagnosticsText: "second",
            copyPreamble: ["SECOND"],
            serializeCopyRow: String,
        });

        expect(second.runId).not.to.equal(first.runId);
        expect(factory.db.keys("copy-line-chunks")).to.deep.equal([
            `${second.runId}:0`,
        ]);
        expect(await loadRankPairsSnapshotCopyText(second)).to.equal("SECOND\n9");
    });
});
