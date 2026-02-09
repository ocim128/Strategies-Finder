export type DebugLevel = 'info' | 'warn' | 'error' | 'event';

export interface DebugEntry {
    id: number;
    ts: number;
    level: DebugLevel;
    message: string;
    data?: unknown;
}

type Listener = (entries: DebugEntry[]) => void;

export class DebugLogger {
    private entries: DebugEntry[] = [];
    private listeners = new Set<Listener>();
    private nextId = 1;
    private maxEntries = 200;

    public log(level: DebugLevel, message: string, data?: unknown) {
        const entry: DebugEntry = {
            id: this.nextId++,
            ts: Date.now(),
            level,
            message,
            data,
        };
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(-this.maxEntries);
        }
        this.listeners.forEach(listener => listener(this.entries));
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
        this.entries = [];
        this.listeners.forEach(listener => listener(this.entries));
    }

    public getEntries(): DebugEntry[] {
        return this.entries.slice();
    }

    public subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export const debugLogger = new DebugLogger();
