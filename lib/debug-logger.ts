export type DebugLevel = 'info' | 'warn' | 'error' | 'event';

export interface DebugEntry {
    id: number;
    ts: number;
    level: DebugLevel;
    message: string;
    data?: unknown;
}

type Listener = (entries: DebugEntry[]) => void;

/**
 * Ring buffer implementation for O(1) overflow handling.
 * Avoids slice() allocation on every new log entry.
 */
class RingBuffer<T> {
    private buffer: (T | undefined)[];
    private head = 0;
    private count = 0;

    constructor(private capacity: number) {
        this.buffer = new Array(capacity);
    }

    push(item: T): void {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
    }

    getAll(): T[] {
        if (this.count === 0) return [];
        const result: T[] = new Array(this.count);
        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.capacity) % this.capacity;
            result[i] = this.buffer[idx]!;
        }
        return result;
    }

    clear(): void {
        this.buffer.fill(undefined);
        this.head = 0;
        this.count = 0;
    }

    get length(): number {
        return this.count;
    }
}

/**
 * Dedicated audit sink for robust_random_wf cell audits.
 * Run-scoped: cleared at start of each robust run to ensure
 * seed export returns current run records only.
 */
export class RobustAuditSink {
    private entries: DebugEntry[] = [];
    private currentRunId: string | null = null;

    /**
     * Start a new run scope. Clears any previous audit entries.
     * Call this at the beginning of each robust finder run.
     */
    public startRun(runId: string): void {
        this.currentRunId = runId;
        this.entries = [];
    }

    /**
     * Get the current run ID, or null if no run started.
     */
    public getCurrentRunId(): string | null {
        return this.currentRunId;
    }

    /**
     * Log an audit entry for the current run.
     * If no run has been started, creates one with a default ID.
     */
    public log(message: string, data?: unknown): void {
        if (this.currentRunId === null) {
            // Auto-start an anonymous run if not explicitly started
            this.startRun('auto-' + Date.now());
        }
        const entry: DebugEntry = {
            id: this.entries.length + 1,
            ts: Date.now(),
            level: 'event',
            message,
            data,
        };
        this.entries.push(entry);
        // Hard cap at 50k entries to prevent extreme memory issues
        // (this is ~25x the original 10k cap per run, supporting very large runs)
        if (this.entries.length > 50000) {
            // Remove oldest 20% to avoid frequent trimming
            this.entries.splice(0, Math.floor(50000 * 0.2));
        }
    }

    /**
     * Clear all entries and reset run state.
     */
    public clear(): void {
        this.entries = [];
        this.currentRunId = null;
    }

    /**
     * Get all entries for the current run.
     */
    public getEntries(): DebugEntry[] {
        return this.entries.slice();
    }

    /**
     * Get entries filtered by predicate (current run only).
     */
    public query(predicate: (entry: DebugEntry) => boolean): DebugEntry[] {
        return this.entries.filter(predicate);
    }

    /**
     * Export audit data for the current run in a deterministic format.
     * Returns null if no run is active.
     */
    public exportCurrentRun(): { runId: string; entries: DebugEntry[]; exportedAt: number } | null {
        if (this.currentRunId === null) return null;
        return {
            runId: this.currentRunId,
            entries: this.entries.slice(),
            exportedAt: Date.now(),
        };
    }
}

export class DebugLogger {
    private entries: RingBuffer<DebugEntry>;
    private listeners = new Set<Listener>();
    private nextId = 1;
    private maxEntries = 200;

    constructor() {
        this.entries = new RingBuffer<DebugEntry>(this.maxEntries);
    }

    public log(level: DebugLevel, message: string, data?: unknown) {
        const entry: DebugEntry = {
            id: this.nextId++,
            ts: Date.now(),
            level,
            message,
            data,
        };
        this.entries.push(entry);
        const allEntries = this.entries.getAll();
        this.listeners.forEach(listener => listener(allEntries));
    }

    public info(message: string, data?: unknown) {
        this.log('info', message, data);
    }

    public warn(message: string, data?: unknown) {
        this.log('warn', message, data);
    }

    public error(message: string, data?: unknown) {
        this.log('error', message, data);
    }

    public event(message: string, data?: unknown) {
        this.log('event', message, data);
    }

    public clear() {
        this.entries.clear();
        this.listeners.forEach(listener => listener([]));
    }

    public getEntries(): DebugEntry[] {
        return this.entries.getAll();
    }

    public subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export const debugLogger = new DebugLogger();

// Global robust audit sink instance
export const robustAuditSink = new RobustAuditSink();
