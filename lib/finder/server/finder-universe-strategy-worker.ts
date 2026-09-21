/**
 * worker_threads entry for the parallel Finder Symbol Universe strategy sweep.
 *
 * One worker executes whole selected entry strategies (one `run_task` message
 * at a time) through the UNCHANGED `runFinderUniverseExecution` core — the
 * exact runner the sequential path and the browser use. Determinism comes
 * from reusing the core plus the seeded param-space generator; nothing in the
 * backtest semantics is forked here.
 *
 * Strategy objects never cross the worker boundary: the task carries keys and
 * the worker resolves them through `loadBuiltInStrategyByKey` (the same call
 * the HTTP handler's `resolveSelectedStrategies` uses).
 *
 * Worker-lifetime state (persists across tasks so multi-strategy jobs reuse
 * it): the resolved strategy selection, and a per-worker dataset cache with
 * the same dedupe/eviction semantics as the plugin's job-level dataset cache.
 * Each worker therefore loads every universe symbol at most once no matter
 * how many strategies it processes. The per-strategy cache stat DELTA is
 * reported back so the job diagnostics keep working (requests/hits/misses are
 * summed across workers; one dataset copy exists per worker, so
 * `uniqueBarsLoaded` honestly counts duplicated loads).
 *
 * The task core (`runFinderUniverseStrategyWorkerTask`) is exported so tests
 * can exercise it in-process with an injected dataset loader; the
 * `!isMainThread` bootstrap at the bottom is the only thread-specific part.
 *
 * Import hygiene (the documented vite.config bundle trap): this file is
 * imported by `finder-vite-plugin.ts` ONLY as types. The runtime worker is
 * bundled from source by esbuild in `finder-universe-strategy-pool.ts`. Do
 * not import `lib/finder-manager.ts`, `lib/data-manager.ts`,
 * `lib/settings-manager.ts`, or anything transitively reaching
 * `lightweight-charts` (ESM-only).
 */

import { parentPort, isMainThread } from "node:worker_threads";
import type { FinderSelectedStrategy } from "../finder-runner";
import type {
    FinderDataSlice,
    FinderDiagnostics,
    FinderOptions,
    FinderUniverseCandidate,
} from "../../types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import type { CapitalSettings } from "../../types/backtest";
import type { RustCapabilities } from "../../rust-engine-client";
import { loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import { runFinderUniverseExecution } from "../finder-runner-universe";
import { FinderParamSpace } from "../finder-param-space";
import { normalizeFinderDateRange, sliceFinderDataWindow, type FinderDateRange } from "../finder-manager-logic";
import { loadServerFinderDataset } from "./server-finder-data-loader";

/** Normalized data-window inputs shared by the worker cache's slice path. */
function resolveWorkerWindowSlice(options: FinderOptions): {
    dataSlice: FinderDataSlice;
    dateRange: FinderDateRange;
} {
    return {
        dataSlice: (options.dataSlice ?? "all") as FinderDataSlice,
        dateRange: normalizeFinderDateRange(options.dataRangeFrom, options.dataRangeTo),
    };
}

export interface FinderUniverseStrategyWorkerTask {
    /** Strategy index in the job's ordered selection (ascending release order). */
    taskIndex: number;
    runId: string;
    interval: string;
    symbols: string[];
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    strategyKey: string;
    /** Exit Strategy Override candidate keys; resolved leniently worker-side. */
    exitStrategyKeys: string[];
    useRustEnginePreference: boolean;
    rustCapabilities?: RustCapabilities;
    /** Symbol (trim+upper) -> provider label; null means the binance default. */
    providerBySymbol: Record<string, string> | null;
}

/** Per-strategy DELTA of the worker dataset cache stats (see module header). */
export interface FinderUniverseWorkerDatasetCacheDelta {
    requests: number;
    hits: number;
    misses: number;
    successfulLoads: number;
    failedLoads: number;
    uniqueBarsLoaded: number;
    /** Cache entries retained by this worker (cumulative, not a delta). */
    cacheEntries: number;
}

export interface FinderUniverseStrategyWorkerResult {
    results: FinderUniverseCandidate[];
    diagnostics: FinderDiagnostics | undefined;
    loadedSymbols: number;
    failedSymbols: string[];
    cancelled: boolean;
    datasetCacheDelta: FinderUniverseWorkerDatasetCacheDelta;
    slowLoads: Array<{ symbol: string; interval: string; ms: number; bars: number }>;
}

export type FinderUniverseStrategyWorkerEvent =
    | {
        type: "progress";
        taskIndex: number;
        percent: number;
        status: string;
        phase: "loading" | "evaluating";
    }
    | {
        type: "strategy_complete";
        taskIndex: number;
        result: FinderUniverseStrategyWorkerResult;
    }
    | {
        type: "strategy_fatal";
        taskIndex: number;
        error: string;
    };

export type FinderUniverseWorkerStrategySelection = {
    entry: FinderSelectedStrategy;
    exitStrategyCandidates?: FinderSelectedStrategy[];
};

/**
 * Worker-lifetime dataset cache with the plugin job cache's semantics:
 * successful loads are retained (and served synchronously via `get`), empty
 * results are retained as terminal misses for the run, thrown errors are
 * evicted so a later strategy can retry, and in-flight loads are deduplicated.
 * Stat/slow-load consumers read per-strategy deltas via `consume*` so the job
 * diagnostics aggregate cleanly across workers.
 */
export interface FinderUniverseWorkerDatasetCache {
    get(symbol: string, interval: string): OHLCVData[] | undefined;
    load(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]>;
    consumeDeltaStats(): FinderUniverseWorkerDatasetCacheDelta;
    consumeSlowLoads(): Array<{ symbol: string; interval: string; ms: number; bars: number }>;
}

export function createUniverseWorkerDatasetCache(args: {
    dataSlice: FinderDataSlice;
    /** Date-window boundaries honored when dataSlice is 'date_range'. */
    dateRange?: FinderDateRange;
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
}): FinderUniverseWorkerDatasetCache {
    const ready = new Map<string, OHLCVData[]>();
    const inFlight = new Map<string, Promise<OHLCVData[]>>();
    const stats = {
        requests: 0,
        hits: 0,
        misses: 0,
        successfulLoads: 0,
        failedLoads: 0,
        uniqueBarsLoaded: 0,
    };
    let slowLoads: Array<{ symbol: string; interval: string; ms: number; bars: number }> = [];
    const keyOf = (symbol: string, interval: string): string => `${symbol}|${interval}`;

    return {
        get(symbol, interval) {
            stats.requests += 1;
            const cached = ready.get(keyOf(symbol, interval));
            if (cached !== undefined) stats.hits += 1;
            return cached;
        },
        load(symbol, interval, signal) {
            stats.requests += 1;
            const key = keyOf(symbol, interval);
            const cachedReady = ready.get(key);
            if (cachedReady !== undefined) {
                stats.hits += 1;
                return Promise.resolve(cachedReady);
            }
            const cached = inFlight.get(key);
            if (cached) {
                stats.hits += 1;
                return cached;
            }
            stats.misses += 1;
            const loadStartedAt = performance.now();
            const promise = args.loadDataset(symbol, interval, signal)
                .then((data) => sliceFinderDataWindow(data, args.dataSlice, args.dateRange))
                .then((data) => {
                    if (!Array.isArray(data) || data.length === 0) {
                        inFlight.delete(key);
                        ready.set(key, data);
                        stats.failedLoads += 1;
                        return data;
                    }
                    stats.successfulLoads += 1;
                    stats.uniqueBarsLoaded += data.length;
                    ready.set(key, data);
                    slowLoads.push({
                        symbol,
                        interval,
                        ms: Math.round((performance.now() - loadStartedAt) * 10) / 10,
                        bars: data.length,
                    });
                    return data;
                })
                .catch((error) => {
                    inFlight.delete(key);
                    stats.failedLoads += 1;
                    throw error;
                });
            inFlight.set(key, promise);
            return promise;
        },
        consumeDeltaStats() {
            const delta = { ...stats, cacheEntries: ready.size };
            stats.requests = 0;
            stats.hits = 0;
            stats.misses = 0;
            stats.successfulLoads = 0;
            stats.failedLoads = 0;
            stats.uniqueBarsLoaded = 0;
            return delta;
        },
        consumeSlowLoads() {
            const consumed = slowLoads;
            slowLoads = [];
            return consumed;
        },
    };
}

// Stateless param-space generator, mirroring the plugin's module-scope reuse.
const paramSpace = new FinderParamSpace();

/**
 * Execute one universe strategy task. Resolves with the strategy's terminal
 * runner output (the `strategy_complete` payload) and throws on a fatal
 * strategy (mapped to `strategy_fatal` by the bootstrap). Progress surfaces
 * through the injected callback so both the worker bootstrap and tests can
 * capture it.
 */
export async function runFinderUniverseStrategyWorkerTask(args: {
    task: FinderUniverseStrategyWorkerTask;
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    /** Worker-lifetime cache reused across this worker's strategies; omitted on the first task. */
    datasetCache?: FinderUniverseWorkerDatasetCache;
    /** Worker-local strategy objects reused across persistent tasks. */
    strategySelection?: FinderUniverseWorkerStrategySelection;
    abortSignal: AbortSignal;
    isCancelled: () => boolean;
    onProgress: (progress: { percent: number; status: string; phase: "loading" | "evaluating" }) => void;
}): Promise<FinderUniverseStrategyWorkerResult> {
    const { task } = args;
    const windowSlice = resolveWorkerWindowSlice(task.options);
    const datasetCache = args.datasetCache
        ?? createUniverseWorkerDatasetCache({
            dataSlice: windowSlice.dataSlice,
            dateRange: windowSlice.dateRange,
            loadDataset: args.loadDataset,
        });

    const selection = args.strategySelection ?? {
        entry: await resolveEntryStrategyStrict(task.strategyKey),
        ...(task.exitStrategyKeys.length > 0
            ? { exitStrategyCandidates: await resolveExitStrategiesLenient(task.exitStrategyKeys) }
            : {}),
    };

    // Mirrors the plugin's resolveServerProvider: normalized symbol lookup
    // with a binance default. Keys arrive pre-normalized from the main thread.
    const getProvider = task.providerBySymbol
        ? (symbol: string): string =>
            task.providerBySymbol![symbol.trim().toUpperCase()] ?? "binance"
        : undefined;

    let phase: "loading" | "evaluating" = "loading";
    let lastPercent = 0;
    const output = await runFinderUniverseExecution(
        {
            interval: task.interval,
            options: task.options,
            settings: task.settings,
            capitalSettings: task.capitalSettings,
            selectedStrategy: selection.entry,
            loadDataset: (symbol, interval, signal) => datasetCache.load(symbol, interval, signal),
            getCachedDataset: (symbol, interval) => datasetCache.get(symbol, interval),
            ...(getProvider ? { getProvider } : {}),
            generateParamSets: (defaultParams: StrategyParams, finderOptions: FinderOptions) =>
                paramSpace.generateParamSets(defaultParams, finderOptions),
            ...(selection.exitStrategyCandidates
                ? { exitStrategyCandidates: selection.exitStrategyCandidates }
                : {}),
            ...(task.useRustEnginePreference === true
                ? { useRustEnginePreference: true }
                : {}),
            ...(task.rustCapabilities ? { rustCapabilities: task.rustCapabilities } : {}),
        },
        {
            setProgress: (percent, text) => {
                phase = "evaluating";
                lastPercent = percent;
                args.onProgress({ percent, status: text, phase });
            },
            setStatus: (text) => {
                args.onProgress({ percent: lastPercent, status: text, phase });
            },
            yieldControl: async () => {
                // Yield to the worker's event loop so stop/parent messages are
                // serviced between evaluation runs.
                await new Promise<void>((resolve) => setImmediate(resolve));
            },
            isCancelled: () => args.isCancelled() || args.abortSignal.aborted,
            // Live per-candidate updates stay on the ordered per-strategy
            // completion path; survivors stream when the strategy releases.
            onResultsUpdate: undefined,
        },
    );

    return {
        results: output.results,
        diagnostics: output.diagnostics,
        loadedSymbols: output.loadedSymbols,
        failedSymbols: output.failedSymbols,
        cancelled: args.isCancelled() || args.abortSignal.aborted,
        datasetCacheDelta: datasetCache.consumeDeltaStats(),
        slowLoads: datasetCache.consumeSlowLoads(),
    };
}

/** Resolve the entry strategy, failing loud on an unknown key (mirrors resolveSelectedStrategies). */
async function resolveEntryStrategyStrict(key: string): Promise<FinderSelectedStrategy> {
    const strategy = await loadBuiltInStrategyByKey(key);
    if (!strategy) {
        throw new Error(`Strategy not loaded: ${key}`);
    }
    return { key, name: strategy.name, strategy };
}

/**
 * Resolve exit strategies leniently (mirrors the plugin's
 * resolveExitStrategyCandidates): unknown keys are skipped; undefined when
 * the surviving list is empty.
 */
async function resolveExitStrategiesLenient(keys: string[]): Promise<FinderSelectedStrategy[] | undefined> {
    const candidates: FinderSelectedStrategy[] = [];
    for (const key of keys) {
        const strategy: Strategy | undefined = await loadBuiltInStrategyByKey(key);
        if (strategy) {
            candidates.push({ key, name: strategy.name, strategy });
        }
    }
    return candidates.length > 0 ? candidates : undefined;
}

if (!isMainThread && parentPort) {
    // Persistent worker: one strategy task at a time; the dataset cache,
    // strategy selection, and stop flag persist across tasks so each worker
    // loads every universe symbol at most once for the whole job.
    let datasetCache: FinderUniverseWorkerDatasetCache | null = null;
    let selectionKey = "";
    let selection: FinderUniverseWorkerStrategySelection | null = null;
    let activeAbort: AbortController | null = null;
    const post = (message: FinderUniverseStrategyWorkerEvent): void => {
        parentPort?.postMessage(message);
    };

    parentPort.on("message", async (message: { type: string; task?: FinderUniverseStrategyWorkerTask }) => {
        if (message.type === "stop") {
            activeAbort?.abort();
            return;
        }
        if (message.type !== "run_task" || !message.task) return;
        const task = message.task;
        activeAbort = new AbortController();
        const nextSelectionKey = `${task.strategyKey}\u0000${task.exitStrategyKeys.join("\u0000")}`;
        try {
            if (selection === null || selectionKey !== nextSelectionKey) {
                selection = {
                    entry: await resolveEntryStrategyStrict(task.strategyKey),
                    ...(task.exitStrategyKeys.length > 0
                        ? { exitStrategyCandidates: await resolveExitStrategiesLenient(task.exitStrategyKeys) }
                        : {}),
                };
                selectionKey = nextSelectionKey;
            }
            datasetCache ??= createUniverseWorkerDatasetCache({
                ...resolveWorkerWindowSlice(task.options),
                // The cache applies the IS window (slice + date range) exactly
                // once to the raw server loader series.
                loadDataset: (symbol, interval, signal) =>
                    loadServerFinderDataset(symbol, interval, signal),
            });
        } catch (error) {
            post({
                type: "strategy_fatal",
                taskIndex: task.taskIndex,
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        runFinderUniverseStrategyWorkerTask({
            task,
            // The cache's own load path applies the IS data slice exactly once
            // (the same loadDatasetWithSlice shape the sequential path uses).
            loadDataset: async (symbol, interval, signal) => datasetCache!.load(symbol, interval, signal),
            datasetCache,
            strategySelection: selection!,
            abortSignal: activeAbort.signal,
            isCancelled: () => activeAbort?.signal.aborted === true,
            onProgress: (progress) => {
                post({
                    type: "progress",
                    taskIndex: task.taskIndex,
                    percent: progress.percent,
                    status: progress.status,
                    phase: progress.phase,
                });
            },
        }).then(
            (result) => {
                post({ type: "strategy_complete", taskIndex: task.taskIndex, result });
            },
            (error) => {
                post({
                    type: "strategy_fatal",
                    taskIndex: task.taskIndex,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        );
    });
}
