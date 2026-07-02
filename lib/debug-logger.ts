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
        // Mirror to the console so error/warn surface in production even when no
        // debug panel is attached. Lower levels stay ring-buffer-only outside of
        // DEV to avoid flooding the console during normal Finder/data operations.
        this.mirrorToConsole(level, message, data);
        if (this.listeners.size === 0) {
            return;
        }
        const allEntries = this.entries.getAll();
        this.notifyListeners(allEntries);
    }

    private mirrorToConsole(level: DebugLevel, message: string, data?: unknown): void {
        const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
        switch (level) {
            case 'error':
                // Always forward; an error logged via debugLogger should never be silent.
                console.error(`[debug] ${message}`, data ?? '');
                return;
            case 'warn':
                console.warn(`[debug] ${message}`, data ?? '');
                return;
            case 'info':
            case 'event':
                if (isDev) console.log(`[debug:${level}] ${message}`, data ?? '');
                return;
        }
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
        this.notifyListeners([]);
    }

    public getEntries(): DebugEntry[] {
        return this.entries.getAll();
    }

    public subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notifyListeners(entries: DebugEntry[]): void {
        this.listeners.forEach(listener => {
            try {
                listener(entries);
            } catch (error) {
                console.warn("[debug-logger] listener failed", error);
            }
        });
    }
}

export const debugLogger = new DebugLogger();
