import { debugLogger } from "../debug-logger";

const DB_NAME = "strategies-finder-rank-pairs-results";
const DB_VERSION = 1;
const META_STORE = "snapshots";
const CHUNK_STORE = "copy-line-chunks";
const LATEST_KEY = "latest";

export const RANK_PAIRS_RESULT_CHUNK_SIZE = 1_000;
export const RANK_PAIRS_RESULT_SCHEMA_VERSION = 1;

export type PersistedRankPairsMode = "history" | "recent200";

interface RankPairsCopyLineChunk {
    key: string;
    runId: string;
    index: number;
    lines: string[];
}

interface StoredRankPairsSnapshot<T> extends RankPairsResultSnapshot<T> {
    key: typeof LATEST_KEY;
}

export interface RankPairsResultSnapshot<T> {
    schemaVersion: typeof RANK_PAIRS_RESULT_SCHEMA_VERSION;
    runId: string;
    mode: PersistedRankPairsMode;
    interval: string;
    completedAt: number;
    resultCount: number;
    chunkCount: number;
    preview: T[];
    summaryText: string;
    diagnosticsText: string;
    copyPreamble: string[];
}

export interface SaveRankPairsResultSnapshotInput<T> {
    mode: PersistedRankPairsMode;
    interval: string;
    results: readonly T[];
    preview: readonly T[];
    summaryText: string;
    diagnosticsText: string;
    copyPreamble: readonly string[];
    serializeCopyRow: (result: T) => string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let dbFactory: IDBFactory | null = null;

function getIndexedDbFactory(): IDBFactory | null {
    return typeof indexedDB === "undefined" ? null : indexedDB;
}

function openDb(): Promise<IDBDatabase> {
    const factory = getIndexedDbFactory();
    if (!factory) {
        return Promise.reject(new Error("IndexedDB is unavailable"));
    }
    if (dbPromise && dbFactory === factory) return dbPromise;

    if (dbPromise && dbFactory !== factory) {
        void dbPromise.then((db) => db.close()).catch(() => undefined);
    }
    dbFactory = factory;
    dbPromise = new Promise((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            dbPromise = null;
            reject(request.error ?? new Error("Failed to open Rank Pairs result storage"));
        };
        request.onblocked = () => {
            dbPromise = null;
            reject(new Error("Rank Pairs result storage upgrade is blocked"));
        };
    });
    return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
}

function chunkKey(runId: string, index: number): string {
    return `${runId}:${index}`;
}

function isSnapshotRecord(value: unknown): value is StoredRankPairsSnapshot<unknown> {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<StoredRankPairsSnapshot<unknown>>;
    return record.key === LATEST_KEY
        && record.schemaVersion === RANK_PAIRS_RESULT_SCHEMA_VERSION
        && typeof record.runId === "string"
        && (record.mode === "history" || record.mode === "recent200")
        && typeof record.interval === "string"
        && Number.isFinite(record.completedAt)
        && Number.isInteger(record.resultCount)
        && Number(record.resultCount) >= 0
        && Number.isInteger(record.chunkCount)
        && Number(record.chunkCount) >= 0
        && Array.isArray(record.preview)
        && typeof record.summaryText === "string"
        && typeof record.diagnosticsText === "string"
        && Array.isArray(record.copyPreamble);
}

async function readStoredSnapshot(
    db: IDBDatabase,
): Promise<StoredRankPairsSnapshot<unknown> | null> {
    const transaction = db.transaction(META_STORE, "readonly");
    const value = await requestResult(transaction.objectStore(META_STORE).get(LATEST_KEY));
    return isSnapshotRecord(value) ? value : null;
}

async function deleteChunks(
    db: IDBDatabase,
    runId: string,
    chunkCount: number,
): Promise<void> {
    if (chunkCount <= 0) return;
    const transaction = db.transaction(CHUNK_STORE, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE);
    for (let index = 0; index < chunkCount; index += 1) {
        store.delete(chunkKey(runId, index));
    }
    await transactionDone(transaction);
}

function createRunId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function saveLatestRankPairsResultSnapshot<T>(
    input: SaveRankPairsResultSnapshotInput<T>,
): Promise<RankPairsResultSnapshot<T>> {
    const db = await openDb();
    const previous = await readStoredSnapshot(db);
    const runId = createRunId();
    const chunkCount = Math.ceil(input.results.length / RANK_PAIRS_RESULT_CHUNK_SIZE);
    let committed = false;

    try {
        for (let index = 0; index < chunkCount; index += 1) {
            const start = index * RANK_PAIRS_RESULT_CHUNK_SIZE;
            const end = Math.min(input.results.length, start + RANK_PAIRS_RESULT_CHUNK_SIZE);
            const lines = new Array<string>(end - start);
            for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
                lines[rowIndex - start] = input.serializeCopyRow(input.results[rowIndex]!);
            }
            const chunk: RankPairsCopyLineChunk = {
                key: chunkKey(runId, index),
                runId,
                index,
                lines,
            };
            const transaction = db.transaction(CHUNK_STORE, "readwrite");
            transaction.objectStore(CHUNK_STORE).put(chunk);
            await transactionDone(transaction);
        }

        const snapshot: StoredRankPairsSnapshot<T> = {
            key: LATEST_KEY,
            schemaVersion: RANK_PAIRS_RESULT_SCHEMA_VERSION,
            runId,
            mode: input.mode,
            interval: input.interval,
            completedAt: Date.now(),
            resultCount: input.results.length,
            chunkCount,
            preview: Array.from(input.preview),
            summaryText: input.summaryText,
            diagnosticsText: input.diagnosticsText,
            copyPreamble: Array.from(input.copyPreamble),
        };
        const transaction = db.transaction(META_STORE, "readwrite");
        transaction.objectStore(META_STORE).put(snapshot);
        await transactionDone(transaction);
        committed = true;

        if (previous && previous.runId !== runId) {
            try {
                await deleteChunks(db, previous.runId, previous.chunkCount);
            } catch (error) {
                debugLogger.warn("rank_pairs.snapshot_cleanup_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const { key: _key, ...publicSnapshot } = snapshot;
        return publicSnapshot;
    } catch (error) {
        if (!committed) {
            await deleteChunks(db, runId, chunkCount).catch(() => undefined);
        }
        throw error;
    }
}

export async function loadLatestRankPairsResultSnapshot<T>(): Promise<RankPairsResultSnapshot<T> | null> {
    const db = await openDb();
    const stored = await readStoredSnapshot(db);
    if (!stored) return null;
    const { key: _key, ...snapshot } = stored;
    return snapshot as RankPairsResultSnapshot<T>;
}

export async function loadRankPairsSnapshotCopyText<T>(
    snapshot: RankPairsResultSnapshot<T>,
): Promise<string> {
    const db = await openDb();
    const sections = [...snapshot.copyPreamble];
    let rowCount = 0;

    for (let index = 0; index < snapshot.chunkCount; index += 1) {
        const transaction = db.transaction(CHUNK_STORE, "readonly");
        const value = await requestResult(
            transaction.objectStore(CHUNK_STORE).get(chunkKey(snapshot.runId, index)),
        ) as RankPairsCopyLineChunk | undefined;
        if (
            !value
            || value.runId !== snapshot.runId
            || value.index !== index
            || !Array.isArray(value.lines)
        ) {
            throw new Error(`Saved Rank Pairs result chunk ${index + 1} is missing`);
        }
        rowCount += value.lines.length;
        if (value.lines.length > 0) sections.push(value.lines.join("\n"));
    }

    if (rowCount !== snapshot.resultCount) {
        throw new Error(
            `Saved Rank Pairs result is incomplete (${rowCount}/${snapshot.resultCount} rows)`,
        );
    }
    return sections.join("\n");
}
