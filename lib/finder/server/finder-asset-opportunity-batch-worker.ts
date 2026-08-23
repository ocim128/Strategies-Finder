/**
 * worker_threads entry for Finder Asset Opportunity asset chunks. The same
 * worker is used by the BATCH holdout sweep and by the Rust-preference single
 * run path.
 *
 * One worker executes whole holdout iterations or contiguous asset chunks
 * (one `run_task` message at a time) via the unchanged
 * `runAssetOpportunityIteration` leaf. The worker keeps a long-lived
 * `assetLoadContext` across tasks so its synthetic leg/pair caches are reused
 * for every task it processes.
 *
 * Strategy objects never cross the worker boundary: the task carries keys and
 * the worker resolves them through `loadBuiltInStrategyByKey` (the same call
 * the HTTP handler's `resolveSelectedStrategies` uses), mirroring the
 * sp500-top-mean worker's registry-based resolution.
 *
 * The task core (`runAssetOpportunityBatchWorkerTask`) is exported so tests
 * can exercise it in-process with an injected dataset loader; the
 * `!isMainThread` bootstrap at the bottom is the only thread-specific part.
 *
 * Import hygiene (the documented vite.config bundle trap): leaf modules only.
 * This file must NOT import `finder-vite-plugin.ts`, `lib/finder-manager.ts`,
 * `lib/data-manager.ts`, `lib/settings-manager.ts`, or anything transitively
 * reaching `lightweight-charts` (ESM-only).
 */

import { parentPort, isMainThread } from "node:worker_threads";
import type { FinderSelectedStrategy } from "../finder-runner";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import type { CapitalSettings } from "../../types/backtest";
import type { FinderOptions } from "../../types/finder";
import type { BatchDatasetLoadContext } from "../../batch-backtest/batch-dataset-loader-core";
import { loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import {
    runAssetOpportunityIteration,
    type AssetOpportunityIterationResult,
} from "./asset-opportunity-iteration";
import {
    createServerFinderAssetOpportunityLoadContext,
    loadServerFinderDataset,
} from "./server-finder-data-loader";
import type { FinderJobPhase } from "./finder-stream-types";
import type { FinderRunLogSink } from "./finder-run-log";
import {
    createAssetOpportunitySignalCache,
    type AssetOpportunitySignalCache,
} from "../finder-asset-opportunity-search-cache";
import {
    sliceFinderAssetDataAtFoldEnd,
    sliceFinderAssetDataStrictlyAfterFoldEnd,
} from "../finder-asset-opportunity-fold";
import type { FinderAssetOpportunityCandidateSummaryRow } from "../finder-asset-opportunity-research-types";

/**
 * One holdout iteration's full input, structured-clone-safe. `options` is the
 * per-iteration clone the batch orchestrator builds (with
 * `assetOpportunity.oosIgnoreLastBars` already set to `holdoutBars`).
 */
export interface AssetOpportunityBatchWorkerTask {
    taskIndex: number;
    holdoutBars: number;
    /** Contiguous asset partition within one holdout; omitted for whole sweeps. */
    assetChunkIndex?: number;
    assetChunkCount?: number;
    includeFullStrategyBreakdown?: boolean;
    runId: string;
    interval: string;
    symbols: string[];
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    strategyKeys: string[];
    exitStrategyKeys: string[];
    useRustEnginePreference: boolean;
    /** Symbol (trim+upper) -> provider label; null when no provider map was supplied. */
    providerBySymbol: Record<string, string> | null;
    candidatePoolSize: number;
    minFreshSupport: number;
    foldEnd?: number;
    /** Fresh-window workers cache raw data and slice inside the iteration leaf. */
    loadDatasetIsRaw?: boolean;
    researchProgram?: "fresh-window";
    /** Benchmark-only structured-clone data source; production workers load from the server loader. */
    inlineDatasets?: Record<string, OHLCVData[]>;
}
export type AssetOpportunityBatchWorkerCommand =
    | { type: "run_task"; task: AssetOpportunityBatchWorkerTask }
    | { type: "stop" };

type AssetOpportunityWorkerStrategySelection = {
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
};

export type AssetOpportunityBatchWorkerEvent =
    | {
        type: "progress";
        taskIndex: number;
        holdoutBars: number;
        percent: number;
        status: string;
        phase: FinderJobPhase;
        /** Snapshot counters from this iteration's progress (see AssetOpportunityIterationProgress). */
        assetIndex: number;
        loadedSymbols: number;
        failedSymbols: number;
        strategyIndex: number;
    }
    | {
        type: "run_log";
        event: string;
        payload: Record<string, unknown>;
    }
    | {
        type: "candidate_summary_chunk";
        taskIndex: number;
        rows: FinderAssetOpportunityCandidateSummaryRow[];
    }
    | {
        type: "iteration_complete";
        taskIndex: number;
        holdoutBars: number;
        results: AssetOpportunityIterationResult["results"];
        totals: AssetOpportunityIterationResult["totals"];
        assetDiagnostics: AssetOpportunityIterationResult["assetDiagnostics"];
        foldMetadata?: AssetOpportunityIterationResult["foldMetadata"];
        expectedCandidateSummaryRows?: number;
        expectedOutcomeSummaryRows?: number;
        cancelled: boolean;
    }
    | {
        type: "iteration_fatal";
        taskIndex: number;
        holdoutBars: number;
        error: string;
    };

/**
 * Execute one batch holdout task. Resolves with the iteration result (the
 * `iteration_complete` payload) and throws on a fatal iteration (mapped to
 * `iteration_fatal` by the bootstrap). Progress and run-log events surface
 * through the injected callbacks so tests can capture them in-process.
 */
export async function runAssetOpportunityBatchWorkerTask(args: {
    task: AssetOpportunityBatchWorkerTask;
    loadDataset: (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ) => Promise<OHLCVData[]>;
    loadForwardDataset?: (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ) => Promise<OHLCVData[]>;
    /** Long-lived context reused across this worker's tasks; omitted on the first task. */
    assetLoadContext?: BatchDatasetLoadContext;
    /** Persistent full-signal cache reused across this worker's holdout tasks. */
    signalCache?: AssetOpportunitySignalCache;
    /** Persistent Rust dataset cache reused across this worker's holdout tasks. */
    rustBatchDatasetCache?: Map<string, Promise<string | null>>;
    /** Worker-local strategy objects reused across persistent holdout tasks. */
    strategySelection?: AssetOpportunityWorkerStrategySelection;
    /** Worker-local normalized candidate parameter sets reused across tasks. */
    paramSetCache?: Map<string, StrategyParams[]>;
    abortSignal: AbortSignal;
    isCancelled: () => boolean;
    onProgress: (progress: {
        percent: number;
        status: string;
        phase: FinderJobPhase;
        assetIndex: number;
        loadedSymbols: number;
        failedSymbols: number;
        strategyIndex: number;
    }) => void;
    onCandidateSummaryChunk?: (rows: FinderAssetOpportunityCandidateSummaryRow[]) => void;
    runLog?: FinderRunLogSink | null;
}): Promise<AssetOpportunityIterationResult> {
    const { task } = args;
    const selectedStrategies = args.strategySelection?.selectedStrategies
        ?? await resolveStrategiesStrict(task.strategyKeys);
    const exitStrategyCandidates = args.strategySelection
        ? args.strategySelection.exitStrategyCandidates
        : await resolveExitStrategiesLenient(task.exitStrategyKeys);
    // Mirrors the plugin's resolveServerProvider: normalized symbol lookup
    // with a binance default. Keys arrive pre-normalized from the main thread.
    const getProvider = task.providerBySymbol
        ? (symbol: string): string =>
            task.providerBySymbol![symbol.trim().toUpperCase()] ?? "binance"
        : undefined;

    return runAssetOpportunityIteration(
        {
            runId: task.runId,
            interval: task.interval,
            symbols: task.symbols,
            options: task.options,
            settings: task.settings,
            capitalSettings: task.capitalSettings,
            selectedStrategies,
            ...(exitStrategyCandidates ? { exitStrategyCandidates } : {}),
            ...(task.useRustEnginePreference === true ? { useRustEnginePreference: true } : {}),
            abortSignal: args.abortSignal,
            loadDataset: args.loadDataset,
            ...(args.loadForwardDataset ? { loadForwardDataset: args.loadForwardDataset } : {}),
            ...(args.assetLoadContext ? { assetLoadContext: args.assetLoadContext } : {}),
            ...(args.rustBatchDatasetCache ? { rustBatchDatasetCache: args.rustBatchDatasetCache } : {}),
            ...(args.paramSetCache ? { paramSetCache: args.paramSetCache } : {}),
            ...(args.signalCache ? { signalCache: args.signalCache } : {}),
            ...(task.includeFullStrategyBreakdown === true ? { includeFullStrategyBreakdown: true } : {}),
            ...(getProvider ? { getProvider } : {}),
            candidatePoolSize: task.candidatePoolSize,
            minFreshSupport: task.minFreshSupport,
            ...(task.foldEnd !== undefined ? { foldEnd: task.foldEnd } : {}),
            ...(task.loadDatasetIsRaw === true ? { loadDatasetIsRaw: true } : {}),
            ...(task.researchProgram ? { researchProgram: task.researchProgram } : {}),
            ...(args.runLog ? { runLog: args.runLog } : {}),
        },
        {
            onProgress: (progress) => {
                args.onProgress({
                    percent: progress.percent,
                    status: progress.status,
                    phase: progress.phase,
                    assetIndex: progress.assetIndex,
                    loadedSymbols: progress.loadedSymbols,
                    failedSymbols: progress.failedSymbols,
                    strategyIndex: progress.strategyIndex,
                });
            },
            onAssetResult: () => {
                // Batch orchestration renders only iteration_done rows; the
                // sequential loop likewise ignores per-asset callbacks.
            },
            onCandidateSummaryChunk: args.onCandidateSummaryChunk,
        },
        () => args.isCancelled() || args.abortSignal.aborted,
    );
}

/** Resolve entry strategies, failing loud on an unknown key (mirrors resolveSelectedStrategies). */
async function resolveStrategiesStrict(keys: string[]): Promise<FinderSelectedStrategy[]> {
    const out: FinderSelectedStrategy[] = [];
    for (const key of keys) {
        const strategy = await loadBuiltInStrategyByKey(key);
        if (!strategy) {
            throw new Error(`Strategy not loaded: ${key}`);
        }
        out.push({ key, name: strategy.name, strategy });
    }
    return out;
}

/**
 * Resolve exit strategies leniently (mirrors the plugin's
 * resolveExitStrategyCandidates): unknown keys are skipped; undefined when the
 * surviving list is empty.
 */
async function resolveExitStrategiesLenient(keys: string[]): Promise<FinderSelectedStrategy[] | undefined> {
    if (keys.length === 0) return undefined;
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
    // Persistent worker: one task at a time; the load context, stop flag, and
    // abort controller persist across tasks so dataset caches are reused for
    // every holdout this worker processes.
    let assetLoadContext: BatchDatasetLoadContext | null = null;
    let signalCache: AssetOpportunitySignalCache | null = null;
    const rustBatchDatasetCache = new Map<string, Promise<string | null>>();
    const paramSetCache = new Map<string, StrategyParams[]>();
    let strategySelectionKey = "";
    let strategySelection: AssetOpportunityWorkerStrategySelection | null = null;
    let activeAbort: AbortController | null = null;
    const post = (message: AssetOpportunityBatchWorkerEvent): void => {
        parentPort?.postMessage(message);
    };

    parentPort.on("message", async (message: AssetOpportunityBatchWorkerCommand) => {
        if (message.type === "stop") {
            activeAbort?.abort();
            return;
        }
        if (message.type !== "run_task") return;
        const task = message.task;
        activeAbort = new AbortController();
        const nextStrategySelectionKey = `${task.strategyKeys.join("\u0000")}\u0001${task.exitStrategyKeys.join("\u0000")}`;
        try {
            if (strategySelection === null || strategySelectionKey !== nextStrategySelectionKey) {
                const selectedStrategies = await resolveStrategiesStrict(task.strategyKeys);
                const exitStrategyCandidates = await resolveExitStrategiesLenient(task.exitStrategyKeys);
                strategySelection = {
                    selectedStrategies,
                    ...(exitStrategyCandidates ? { exitStrategyCandidates } : {}),
                };
                strategySelectionKey = nextStrategySelectionKey;
            }
        } catch (error) {
            post({
                type: "iteration_fatal",
                taskIndex: task.taskIndex,
                holdoutBars: task.holdoutBars,
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        // symbolCount attaches the cross-iteration plain-dataset LRU so this
        // worker loads each symbol once across ALL holdout tasks it processes.
        assetLoadContext ??= createServerFinderAssetOpportunityLoadContext(task.symbols.length);
        signalCache ??= createAssetOpportunitySignalCache();
        runAssetOpportunityBatchWorkerTask({
            task,
            loadDataset: task.inlineDatasets
                ? async (symbol) => task.loadDatasetIsRaw === true
                    ? (task.inlineDatasets![symbol] ?? [])
                    : sliceFinderAssetDataAtFoldEnd(task.inlineDatasets![symbol] ?? [], task.foldEnd)
                : async (symbol, interval, signal, context) =>
                    task.loadDatasetIsRaw === true
                        ? loadServerFinderDataset(symbol, interval, signal, context)
                        : loadServerFinderDataset(symbol, interval, signal, context).then((data) =>
                            sliceFinderAssetDataAtFoldEnd(data, task.foldEnd)),
            ...(task.foldEnd !== undefined
                ? {
                    loadForwardDataset: task.inlineDatasets
                        ? async (symbol) => task.loadDatasetIsRaw === true
                            ? (task.inlineDatasets![symbol] ?? [])
                            : sliceFinderAssetDataStrictlyAfterFoldEnd(
                                task.inlineDatasets![symbol] ?? [],
                                task.foldEnd,
                            )
                        : async (symbol, interval, signal, context) =>
                            task.loadDatasetIsRaw === true
                                ? loadServerFinderDataset(symbol, interval, signal, context)
                                : loadServerFinderDataset(symbol, interval, signal, context).then((data) =>
                                    sliceFinderAssetDataStrictlyAfterFoldEnd(data, task.foldEnd)),
                }
                : {}),
            assetLoadContext,
            rustBatchDatasetCache,
            paramSetCache,
            signalCache,
            strategySelection: strategySelection!,
            abortSignal: activeAbort.signal,
            isCancelled: () => activeAbort?.signal.aborted === true,
            onProgress: (progress) => {
                post({
                    type: "progress",
                    taskIndex: task.taskIndex,
                    holdoutBars: task.holdoutBars,
                    percent: progress.percent,
                    status: progress.status,
                    phase: progress.phase,
                    assetIndex: progress.assetIndex,
                    loadedSymbols: progress.loadedSymbols,
                    failedSymbols: progress.failedSymbols,
                    strategyIndex: progress.strategyIndex,
                });
            },
            runLog: (event, payload) => {
                post({ type: "run_log", event, payload });
            },
            onCandidateSummaryChunk: (rows) => {
                post({ type: "candidate_summary_chunk", taskIndex: task.taskIndex, rows });
            },
        }).then(
            (iteration) => {
                post({
                    type: "iteration_complete",
                    taskIndex: task.taskIndex,
                    holdoutBars: task.holdoutBars,
                    results: iteration.results,
                    totals: iteration.totals,
                    assetDiagnostics: iteration.assetDiagnostics,
                    ...(iteration.foldMetadata ? { foldMetadata: iteration.foldMetadata } : {}),
                    ...(iteration.expectedCandidateSummaryRows !== undefined
                        ? { expectedCandidateSummaryRows: iteration.expectedCandidateSummaryRows }
                        : {}),
                    ...(iteration.expectedOutcomeSummaryRows !== undefined
                        ? { expectedOutcomeSummaryRows: iteration.expectedOutcomeSummaryRows }
                        : {}),
                    cancelled: iteration.cancelled,
                });
            },
            (error) => {
                post({
                    type: "iteration_fatal",
                    taskIndex: task.taskIndex,
                    holdoutBars: task.holdoutBars,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        );
    });
}
