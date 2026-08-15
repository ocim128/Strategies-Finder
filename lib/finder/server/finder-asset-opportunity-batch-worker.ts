/**
 * worker_threads entry for the Finder Asset Opportunity BATCH holdout sweep.
 *
 * One worker executes whole holdout iterations (one `run_task` message at a
 * time) via the unchanged `runAssetOpportunityIteration` leaf. The worker
 * keeps a long-lived `assetLoadContext` across tasks so its synthetic
 * leg/pair caches are reused for every holdout it processes — the same
 * cross-iteration reuse the sequential batch loop gets from its single
 * context.
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
import type { BacktestSettings, OHLCVData, Strategy } from "../../types/strategies";
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

/**
 * One holdout iteration's full input, structured-clone-safe. `options` is the
 * per-iteration clone the batch orchestrator builds (with
 * `assetOpportunity.oosIgnoreLastBars` already set to `holdoutBars`).
 */
export interface AssetOpportunityBatchWorkerTask {
    taskIndex: number;
    holdoutBars: number;
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
}
export type AssetOpportunityBatchWorkerCommand =
    | { type: "run_task"; task: AssetOpportunityBatchWorkerTask }
    | { type: "stop" };

export type AssetOpportunityBatchWorkerEvent =
    | {
        type: "progress";
        taskIndex: number;
        holdoutBars: number;
        percent: number;
        status: string;
        phase: FinderJobPhase;
        /** Snapshot counters from this iteration's progress (see AssetOpportunityIterationProgress). */
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
        type: "iteration_complete";
        taskIndex: number;
        holdoutBars: number;
        results: AssetOpportunityIterationResult["results"];
        totals: AssetOpportunityIterationResult["totals"];
        assetDiagnostics: AssetOpportunityIterationResult["assetDiagnostics"];
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
    /** Long-lived context reused across this worker's tasks; omitted on the first task. */
    assetLoadContext?: BatchDatasetLoadContext;
    abortSignal: AbortSignal;
    isCancelled: () => boolean;
    onProgress: (progress: {
        percent: number;
        status: string;
        phase: FinderJobPhase;
        loadedSymbols: number;
        failedSymbols: number;
        strategyIndex: number;
    }) => void;
    runLog?: FinderRunLogSink | null;
}): Promise<AssetOpportunityIterationResult> {
    const { task } = args;
    const selectedStrategies = await resolveStrategiesStrict(task.strategyKeys);
    const exitStrategyCandidates = await resolveExitStrategiesLenient(task.exitStrategyKeys);
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
            ...(args.assetLoadContext ? { assetLoadContext: args.assetLoadContext } : {}),
            ...(getProvider ? { getProvider } : {}),
            candidatePoolSize: task.candidatePoolSize,
            minFreshSupport: task.minFreshSupport,
            ...(args.runLog ? { runLog: args.runLog } : {}),
        },
        {
            onProgress: (progress) => {
                args.onProgress({
                    percent: progress.percent,
                    status: progress.status,
                    phase: progress.phase,
                    loadedSymbols: progress.loadedSymbols,
                    failedSymbols: progress.failedSymbols,
                    strategyIndex: progress.strategyIndex,
                });
            },
            onAssetResult: () => {
                // Batch orchestration renders only iteration_done rows; the
                // sequential loop likewise ignores per-asset callbacks.
            },
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
    let activeAbort: AbortController | null = null;
    const post = (message: AssetOpportunityBatchWorkerEvent): void => {
        parentPort?.postMessage(message);
    };

    parentPort.on("message", (message: AssetOpportunityBatchWorkerCommand) => {
        if (message.type === "stop") {
            activeAbort?.abort();
            return;
        }
        if (message.type !== "run_task") return;
        const task = message.task;
        activeAbort = new AbortController();
        assetLoadContext ??= createServerFinderAssetOpportunityLoadContext();
        runAssetOpportunityBatchWorkerTask({
            task,
            loadDataset: loadServerFinderDataset,
            assetLoadContext,
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
                    loadedSymbols: progress.loadedSymbols,
                    failedSymbols: progress.failedSymbols,
                    strategyIndex: progress.strategyIndex,
                });
            },
            runLog: (event, payload) => {
                post({ type: "run_log", event, payload });
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
