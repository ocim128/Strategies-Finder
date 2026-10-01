import type { OHLCVData } from '../../lib/types/strategies';

export type TestCandleRecord = {
    key: string;
    candles: OHLCVData[];
    updatedAt: number;
};

/** Minimal transactional IDB fixture: failed writes never commit their record. */
export class FakeCandleIndexedDb {
    readonly records = new Map<string, TestCandleRecord>();
    readonly writes: TestCandleRecord[] = [];
    reads = 0;
    nextWriteOutcome: 'complete' | 'error' | 'abort' | 'throw' = 'complete';

    private readonly db = {
        objectStoreNames: { contains: () => true },
        close: () => {},
        transaction: (_name: unknown, mode: string) => {
            const tx = {
                oncomplete: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onabort: null as (() => void) | null,
                objectStore: () => ({
                    get: (key: string) => {
                        this.reads++;
                        const request = { result: undefined as TestCandleRecord | undefined, onsuccess: null as (() => void) | null };
                        queueMicrotask(() => {
                            request.result = this.records.get(key);
                            request.onsuccess?.();
                        });
                        return request;
                    },
                    put: (record: TestCandleRecord) => {
                        const outcome = this.nextWriteOutcome;
                        this.nextWriteOutcome = 'complete';
                        if (outcome === 'throw') throw new Error('Storage blocked');
                        const copy = structuredClone(record);
                        this.writes.push(copy);
                        queueMicrotask(() => {
                            if (outcome === 'error') tx.onerror?.();
                            else if (outcome === 'abort') tx.onabort?.();
                            else {
                                this.records.set(copy.key, copy);
                                tx.oncomplete?.();
                            }
                        });
                    },
                }),
            };
            if (mode !== 'readwrite') queueMicrotask(() => tx.oncomplete?.());
            return tx;
        },
    };

    open() {
        const request = { result: this.db, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
    }

    deleteDatabase() {
        const request = { onsuccess: null as (() => void) | null };
        queueMicrotask(() => { this.records.clear(); request.onsuccess?.(); });
        return request;
    }
}
