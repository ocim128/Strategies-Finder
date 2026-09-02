import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
    PreparedTradeLedgerReplay,
    TradeLedgerControlRunResult,
    TradeLedgerControlRunner,
    TradeLedgerControlRunnerInput,
} from "./trade-ledger-replay-core";

export interface SharedTradeLedgerControlDataset {
    count: number;
    pairCount: number;
    signalTimes: SharedArrayBuffer;
    signalBarIndices: SharedArrayBuffer;
    barsHeld: SharedArrayBuffer;
    pnlPercents: SharedArrayBuffer;
    pairOffsets: SharedArrayBuffer;
    pairSignalBarsMonotonic: SharedArrayBuffer;
    pairNextCursors: SharedArrayBuffer;
}

export interface TradeLedgerControlWorkerRunMessage {
    type: "run";
    taskId: string;
    startK: number;
    endK: number;
    controlSeed: number;
    calibratedP: number;
    replay: TradeLedgerControlRunnerInput["replay"];
    shift: number;
    splitTime: number;
}

export interface TradeLedgerControlWorkerDoneMessage {
    type: "done";
    taskId: string;
    results: Array<{ k: number; result: TradeLedgerControlRunResult }>;
}

interface TradeLedgerControlWorkerReadyMessage {
    type: "ready";
}

interface TradeLedgerControlWorkerErrorMessage {
    type: "error";
    taskId: string;
    error: string;
}

type TradeLedgerControlWorkerMessage =
    | TradeLedgerControlWorkerReadyMessage
    | TradeLedgerControlWorkerDoneMessage
    | TradeLedgerControlWorkerErrorMessage;

interface PendingRun {
    remaining: number;
    results: Array<{ k: number; result: TradeLedgerControlRunResult }>;
    resolve: (results: readonly TradeLedgerControlRunResult[]) => void;
    reject: (error: Error) => void;
    /** Task ids whose first attempt failed and were re-posted to another worker. */
    retriedTasks: Set<string>;
    firstError: string | null;
    chunks: Map<string, TradeLedgerControlWorkerRunMessage>;
}

export interface TradeLedgerControlPool {
    readonly workerCount: number;
    readonly run: TradeLedgerControlRunner;
    close(): Promise<void>;
}

const SMALL_DATASET_WORKER_COUNT = 4;
const LARGE_DATASET_THRESHOLD = 250_000;
const RESERVED_LOGICAL_CPUS = 1;
const MAX_WORKER_COUNT = Math.max(1, availableParallelism() - RESERVED_LOGICAL_CPUS);
const LARGE_DATASET_WORKER_COUNT = Math.min(20, MAX_WORKER_COUNT);

function sharedFloat64Buffer(length: number): SharedArrayBuffer {
    return new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT);
}

function sharedUint32Buffer(length: number): SharedArrayBuffer {
    return new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT);
}

function sharedUint8Buffer(length: number): SharedArrayBuffer {
    return new SharedArrayBuffer(length * Uint8Array.BYTES_PER_ELEMENT);
}

function buildSharedDataset(prepared: PreparedTradeLedgerReplay): SharedTradeLedgerControlDataset {
    const rows = prepared.controlRows;
    if (rows.length > 0xFFFFFFFF) throw new Error("Ledger control candidate count exceeds the worker index limit.");
    if (prepared.controlPairs.size > 0xFFFFFFFF) throw new Error("Ledger control pair count exceeds the worker index limit.");

    const signalTimesBuffer = sharedFloat64Buffer(rows.length);
    const signalBarIndicesBuffer = sharedFloat64Buffer(rows.length);
    const barsHeldBuffer = sharedFloat64Buffer(rows.length);
    const pnlPercentsBuffer = sharedFloat64Buffer(rows.length);
    const signalTimes = new Float64Array(signalTimesBuffer);
    const signalBarIndices = new Float64Array(signalBarIndicesBuffer);
    const barsHeld = new Float64Array(barsHeldBuffer);
    const pnlPercents = new Float64Array(pnlPercentsBuffer);
    const pairOffsetsBuffer = sharedUint32Buffer(prepared.controlPairs.size + 1);
    const pairSignalBarsMonotonicBuffer = sharedUint8Buffer(prepared.controlPairs.size);
    const pairNextCursorsBuffer = sharedUint32Buffer(rows.length);
    const pairOffsets = new Uint32Array(pairOffsetsBuffer);
    const pairSignalBarsMonotonic = new Uint8Array(pairSignalBarsMonotonicBuffer);
    const pairNextCursors = new Uint32Array(pairNextCursorsBuffer);
    let cursor = 0;
    let pairIndex = 0;
    for (const pairRows of prepared.controlPairs.values()) {
        pairOffsets[pairIndex] = cursor;
        let previousSignalBar = Number.NEGATIVE_INFINITY;
        let monotonic = true;
        for (const row of pairRows) {
            const asIf = row.asIf!;
            if (!Number.isFinite(row.signalBarIndex) || !Number.isFinite(row.asIf!.barsHeld) || row.signalBarIndex < previousSignalBar) monotonic = false;
            previousSignalBar = row.signalBarIndex;
            signalTimes[cursor] = row.signalTime;
            signalBarIndices[cursor] = row.signalBarIndex;
            barsHeld[cursor] = asIf.barsHeld;
            pnlPercents[cursor] = asIf.pnlPercent;
            cursor += 1;
        }
        pairSignalBarsMonotonic[pairIndex] = monotonic ? 1 : 0;
        let nextCursor = pairOffsets[pairIndex]!;
        for (let pairCursor = pairOffsets[pairIndex]!; pairCursor < cursor; pairCursor += 1) {
            const blockedThrough = signalBarIndices[pairCursor]! + barsHeld[pairCursor]!;
            if (nextCursor < pairCursor + 1) nextCursor = pairCursor + 1;
            while (nextCursor < cursor) {
                if (signalBarIndices[nextCursor]! > blockedThrough) break;
                nextCursor += 1;
            }
            pairNextCursors[pairCursor] = nextCursor;
        }
        pairIndex += 1;
    }
    pairOffsets[pairIndex] = cursor;
    if (cursor !== rows.length) throw new Error("Control pair rows do not match the candidate row count.");

    return {
        count: rows.length,
        pairCount: prepared.controlPairs.size,
        signalTimes: signalTimesBuffer,
        signalBarIndices: signalBarIndicesBuffer,
        barsHeld: barsHeldBuffer,
        pnlPercents: pnlPercentsBuffer,
        pairOffsets: pairOffsetsBuffer,
        pairSignalBarsMonotonic: pairSignalBarsMonotonicBuffer,
        pairNextCursors: pairNextCursorsBuffer,
    };
}

function requestedWorkerCount(candidateCount: number): number {
    const configured = Number(process.env.TRADE_LEDGER_SWEEP_CONTROL_WORKERS);
    if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
    if (candidateCount >= LARGE_DATASET_THRESHOLD) return LARGE_DATASET_WORKER_COUNT;
    return Math.min(SMALL_DATASET_WORKER_COUNT, MAX_WORKER_COUNT);
}

function defaultWorkerPath(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/trade-ledger-control-worker.mjs");
}

/**
 * Create a bounded worker-thread pool over shared candidate columns. Workers
 * never receive the parsed ledger object graph; only the compact immutable
 * control columns and pair offsets are shared.
 */
export function createTradeLedgerControlPool(
    prepared: PreparedTradeLedgerReplay,
    options: { workerCount?: number; workerPath?: string } = {},
): TradeLedgerControlPool {
    const dataset = buildSharedDataset(prepared);
    const workerCount = Math.max(1, Math.min(
        options.workerCount ?? requestedWorkerCount(prepared.controlRows.length),
        MAX_WORKER_COUNT,
    ));
    const workers = Array.from({ length: workerCount }, () => new Worker(options.workerPath ?? defaultWorkerPath(), {
        workerData: { dataset },
    }));
    const readyWorkers = new Set<Worker>();
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    let closed = false;
    let fatalError: Error | null = null;
    let activeRun: PendingRun | null = null;
    let nextTaskId = 0;

    const fail = (error: Error): void => {
        if (fatalError) return;
        fatalError = error;
        readyReject?.(error);
        if (activeRun) {
            activeRun.reject(error);
            activeRun = null;
        }
    };

    workers.forEach((worker, workerIndex) => {
        worker.on("message", (message: TradeLedgerControlWorkerMessage) => {
            if (message.type === "ready") {
                readyWorkers.add(worker);
                if (readyWorkers.size === workers.length) readyResolve?.();
                return;
            }
            if (message.type === "error") {
                // runControl is deterministic (seeded PRNG over immutable shared
                // columns), so a failed chunk is safe to re-post once to a
                // different worker. A genuine bug fails the retry identically.
                const pending = activeRun;
                const retried = pending?.retriedTasks.has(message.taskId) ?? true;
                if (pending && !retried) {
                    pending.retriedTasks.add(message.taskId);
                    pending.firstError = message.error;
                    const nextIndex = (workerIndex + 1) % workers.length;
                    const chunk = pending.chunks.get(message.taskId);
                    if (chunk) {
                        workers[nextIndex]!.postMessage(chunk);
                        return;
                    }
                }
                const suffix = pending?.firstError && pending.firstError !== message.error ? `\nfirst attempt: ${pending.firstError}` : "";
                fail(new Error(`${message.error}${suffix}`));
                return;
            }
            const pending = activeRun;
            if (!pending) return;
            pending.results.push(...message.results);
            pending.remaining -= 1;
            if (pending.remaining === 0) {
                activeRun = null;
                pending.resolve(pending.results
                    .sort((a, b) => a.k - b.k)
                    .map((entry) => entry.result));
            }
        });
        worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
        worker.on("exit", (code) => {
            if (!closed && code !== 0) fail(new Error(`Ledger control worker exited with code ${code}.`));
        });
    });

    const run: TradeLedgerControlRunner = async (input) => {
        if (closed) throw new Error("Ledger control pool is closed.");
        if (fatalError) throw fatalError;
        if (activeRun) throw new Error("Ledger control pool does not support overlapping runs.");
        await ready;
        if (fatalError) throw fatalError;
        if (activeRun) throw new Error("Ledger control pool does not support overlapping runs.");
        if (input.controlRuns <= 0) return [];
        const partCount = Math.min(workerCount, input.controlRuns);
        const pending = await new Promise<readonly TradeLedgerControlRunResult[]>((resolve, reject) => {
            const state: PendingRun = { remaining: partCount, results: [], resolve, reject, retriedTasks: new Set<string>(), firstError: null, chunks: new Map<string, TradeLedgerControlWorkerRunMessage>() };
            activeRun = state;
            const base = Math.floor(input.controlRuns / partCount);
            const remainder = input.controlRuns % partCount;
            let startK = 0;
            for (let part = 0; part < partCount; part += 1) {
                const endK = startK + base + (part < remainder ? 1 : 0);
                const message: TradeLedgerControlWorkerRunMessage = {
                    type: "run",
                    taskId: `${nextTaskId++}`,
                    startK,
                    endK,
                    controlSeed: input.controlSeed,
                    calibratedP: input.calibratedP,
                    replay: input.replay,
                    shift: input.shift,
                    splitTime: input.splitTime,
                };
                state.chunks.set(message.taskId, message);
                try {
                    workers[part]!.postMessage(message);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                    break;
                }
                startK = endK;
            }
        });
        return pending;
    };

    return {
        workerCount,
        run,
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            const error = new Error("Ledger control pool closed.");
            if (activeRun) {
                activeRun.reject(error);
                activeRun = null;
            }
            await Promise.all(workers.map((worker) => worker.terminate()));
        },
    };
}
