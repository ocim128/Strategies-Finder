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
    openCalls = 0;
    closedConnections = 0;
    nextOpenOutcome: 'success' | 'error' | 'throw' | 'blocked' | 'stall' = 'success';
    nextReadOutcome: 'success' | 'error' | 'abort' | 'throw' = 'success';
    private pendingOpen: (() => void) | null = null;
    nextWriteOutcome: 'complete' | 'error' | 'abort' | 'throw' = 'complete';

    private readonly db = {
        objectStoreNames: { contains: () => true },
        onversionchange: null as (() => void) | null,
        onclose: null as (() => void) | null,
        close: () => { this.closedConnections++; },
        transaction: (_name: unknown, mode: string) => {
            const readOutcome = this.nextReadOutcome;
            if (mode === 'readonly') {
                this.nextReadOutcome = 'success';
                if (readOutcome === 'throw') throw new Error('Read storage blocked');
            }
            const tx = {
                oncomplete: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onabort: null as (() => void) | null,
                objectStore: () => ({
                    get: (key: string) => {
                        this.reads++;
                        const request = { result: undefined as TestCandleRecord | undefined, onsuccess: null as (() => void) | null };
                        queueMicrotask(() => {
                            if (readOutcome === 'error') tx.onerror?.();
                            else if (readOutcome === 'abort') tx.onabort?.();
                            else {
                                request.result = this.records.get(key);
                                request.onsuccess?.();
                            }
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
        this.openCalls++;
        const outcome = this.nextOpenOutcome;
        this.nextOpenOutcome = 'success';
        if (outcome === 'throw') throw new Error('Open storage blocked');
        const request = { result: this.db, onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null, onblocked: null as (() => void) | null,
            error: new Error('Open failed') };
        this.pendingOpen = () => request.onsuccess?.();
        if (outcome !== 'stall') queueMicrotask(() => {
            if (outcome === 'error') request.onerror?.();
            else if (outcome === 'blocked') request.onblocked?.();
            else request.onsuccess?.();
        });
        return request;
    }

    completePendingOpen() { this.pendingOpen?.(); }
    versionChange() { this.db.onversionchange?.(); }

    deleteDatabase() {
        const request = { onsuccess: null as (() => void) | null };
        queueMicrotask(() => { this.records.clear(); request.onsuccess?.(); });
        return request;
    }
}
