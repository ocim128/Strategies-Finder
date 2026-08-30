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
    pairIndices: SharedArrayBuffer;
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
}

export interface TradeLedgerControlPool {
    readonly workerCount: number;
    readonly run: TradeLedgerControlRunner;
    close(): Promise<void>;
}

const DEFAULT_WORKER_COUNT = 4;

function sharedFloat64Buffer(length: number): SharedArrayBuffer {
    return new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT);
}

function sharedUint32Buffer(length: number): SharedArrayBuffer {
    return new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT);
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
    const rowIndexes = new Map<PreparedTradeLedgerReplay["controlRows"][number], number>();
    rows.forEach((row, index) => {
        const asIf = row.asIf!;
        signalTimes[index] = row.signalTime;
        signalBarIndices[index] = row.signalBarIndex;
        barsHeld[index] = asIf.barsHeld;
        pnlPercents[index] = asIf.pnlPercent;
        rowIndexes.set(row, index);
    });

    const pairOffsetsBuffer = sharedUint32Buffer(prepared.controlPairs.size + 1);
    const pairIndicesBuffer = sharedUint32Buffer(rows.length);
    const pairOffsets = new Uint32Array(pairOffsetsBuffer);
    const pairIndices = new Uint32Array(pairIndicesBuffer);
    let cursor = 0;
    let pairIndex = 0;
    for (const pairRows of prepared.controlPairs.values()) {
        pairOffsets[pairIndex] = cursor;
        for (const row of pairRows) {
            const index = rowIndexes.get(row);
            if (index === undefined) throw new Error("Control pair index is missing from the candidate index.");
            pairIndices[cursor] = index;
            cursor += 1;
        }
        pairIndex += 1;
    }
    pairOffsets[pairIndex] = cursor;

    return {
        count: rows.length,
        pairCount: prepared.controlPairs.size,
        signalTimes: signalTimesBuffer,
        signalBarIndices: signalBarIndicesBuffer,
        barsHeld: barsHeldBuffer,
        pnlPercents: pnlPercentsBuffer,
        pairOffsets: pairOffsetsBuffer,
        pairIndices: pairIndicesBuffer,
    };
}

function requestedWorkerCount(): number {
    const configured = Number(process.env.TRADE_LEDGER_SWEEP_CONTROL_WORKERS);
    if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
    return Math.max(1, Math.min(DEFAULT_WORKER_COUNT, availableParallelism() - 1));
}

function defaultWorkerPath(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/trade-ledger-control-worker.mjs");
}

/**
 * Create a bounded worker-thread pool over shared candidate columns. Workers
 * never receive the parsed ledger object graph; only the compact immutable
 * control columns and pair indexes are shared.
 */
export function createTradeLedgerControlPool(
    prepared: PreparedTradeLedgerReplay,
    options: { workerCount?: number; workerPath?: string } = {},
): TradeLedgerControlPool {
    const dataset = buildSharedDataset(prepared);
    const workerCount = Math.max(1, Math.min(options.workerCount ?? requestedWorkerCount(), DEFAULT_WORKER_COUNT));
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

    for (const worker of workers) {
        worker.on("message", (message: TradeLedgerControlWorkerMessage) => {
            if (message.type === "ready") {
                readyWorkers.add(worker);
                if (readyWorkers.size === workers.length) readyResolve?.();
                return;
            }
            if (message.type === "error") {
                fail(new Error(message.error));
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
    }

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
            const state: PendingRun = { remaining: partCount, results: [], resolve, reject };
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
