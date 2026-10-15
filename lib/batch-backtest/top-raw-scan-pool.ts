import { Worker } from "node:worker_threads";
import { resolveServerWorkerEntryPath, resolveTopMeanWorkerCount } from "./sp500-top-mean-worker-pool";
import type { ScanWorkerTask } from "./top-raw-scan-worker";

/** A fixed set of persistent workers; the owner dispatches at most one task per slot. */
export class ScanWorkerPool {
    private workers: Worker[] = [];
    private pending = new Map<Worker, (error: Error) => void>();
    private dead = new Set<Worker>();
    private stopped = false;
    private terminations: Promise<unknown>[] = [];
    public workerPath = "";
    async initialize(count?: number): Promise<void> {
        this.workerPath = await resolveServerWorkerEntryPath("top-raw-scan-worker.ts");
        if (this.stopped) throw new Error("Scan stopped.");
        for (let i = 0; i < resolveTopMeanWorkerCount(count); i++) {
            const worker = new Worker(this.workerPath, { execArgv: [] });
            worker.on("error", error => { this.dead.add(worker); this.pending.get(worker)?.(error instanceof Error ? error : new Error(String(error))); });
            worker.on("exit", code => { this.dead.add(worker); this.pending.get(worker)?.(new Error(`Scan worker exited (${code}).`)); });
            this.workers.push(worker);
        }
    }
    get size(): number { return this.workers.length; }
    task<T>(index: number, task: ScanWorkerTask): Promise<T> {
        if (this.stopped) return Promise.reject(new Error("Scan stopped."));
        const worker = this.workers[index];
        if (!worker || this.dead.has(worker) || this.pending.has(worker)) return Promise.reject(new Error("Scan worker unavailable."));
        return new Promise<T>((resolve, reject) => {
            const finish = (error?: Error, value?: T) => { worker.off("message", onMessage); this.pending.delete(worker); error ? reject(error) : resolve(value!); };
            const onMessage = (message: { error?: string; value: T }) => finish(message.error ? new Error(message.error) : undefined, message.value);
            this.pending.set(worker, error => finish(error)); worker.once("message", onMessage);
            try { worker.postMessage(task); } catch (error) { finish(error as Error); }
        });
    }
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const [worker, reject] of this.pending) { reject(new Error("Scan stopped.")); void worker; }
        for (const worker of this.workers) this.terminations.push(worker.terminate());
    }
    async dispose(): Promise<void> { this.stop(); await Promise.allSettled(this.terminations); this.workers = []; }
}
