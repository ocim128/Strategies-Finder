/**
 * Vite dev-server plugin that OWNS the complete Finder Symbol Universe job
 * lifecycle in Node.
 *
 * One server job owns all selected entry strategies: it sequences each
 * through the unchanged `runFinderUniverseExecution(...)` core, merges the
 * scalar survivors, runs the optional OOS pass, and publishes one
 * authoritative terminal candidate slice. The browser remains the control +
 * rendering layer and reattaches after a tab reload by polling
 * `GET /api/finder/status?runId=...`.
 *
 * Why server-owned at all: the Finder Symbol Universe runner holds N full
 * OHLCV datasets (~5–10 MB each at the 100k-bar cap) in memory for the whole
 * evaluation loop. That workload OOMs a browser tab on large universes; Node
 * can use main RAM directly. Server-owned execution + server-owned OOS means
 * the browser tab holds only the rendered scalar survivor rows for the entire
 * run, including the OOS pass.
 *
 * What this plugin is NOT:
 *   - It has NO Mine / artifact / TTL surface. Universe has no Mine step;
 *     copying Batch's artifact directory + 10-min TTL machinery would be dead
 *     code. The server holds datasets only for the run duration (plus OOS),
 *     then releases them.
 *   - It does NOT touch the current-chart Finder path.
 *   - It does NOT broaden Universe to Polymarket scoring (Universe rejects
 *     it in `assertUniverseRunSupported`).
 *
 * The core `runFinderUniverseExecution` is reused UNCHANGED — server-side
 * dispatch only swaps the `loadDataset` callback for the Node-side loader.
 * Determinism and browser/server parity come from reusing the same core. The
 * OOS pass is the extracted leaf `runUniverseOosPass(...)`, a faithful lift
 * of the prior `FinderManager.applyUniverseOosValidationIfNeeded` body with
 * all runtime dependencies injected.
 *
 * Reattach: the browser persists the active `runId` before `fetch` and polls
 * `GET /api/finder/status?runId=...` on Finder init to recover an in-flight
 * or terminal job. Reattach only survives a browser reload while the same
 * Vite process remains alive; a Vite restart loses the in-memory job.
 *
 * MEMORY CONTRACT (test-enforced): every `candidate` event and the terminal
 * status candidate slice MUST be scalar-only. `toScalarCandidate` +
 * `assertCandidateIsScalar` enforce this at the source so a future field that
 * accidentally carries an OHLCV / signals / trades array cannot reach the
 * wire and re-pressurize the browser tab. In-progress `/status` polls carry
 * candidate COUNTS only — never the per-symbol payload — so polling stays
 * small while a large universe runs.
 */

import type { Plugin } from "vite";
import { getHeapStatistics } from "node:v8";
import { totalmem } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { debugLogger } from "../../debug-logger";
import {
    beginNdjsonStream,
    HttpStatusError,
    readJsonBody,
    registerLocalJsonRoute,
    sendJson,
    type ViteHttpResponse,
} from "../../vite-http-utils";
import { runFinderUniverseExecution } from "../finder-runner-universe";
import type { FinderSelectedStrategy } from "../finder-runner";
import { FinderParamSpace } from "../finder-param-space";
import { sliceFinderDataWindow } from "../finder-manager-logic";
import {
    FINDER_ASSET_FRESH_FOLD_COUNT,
    FINDER_ASSET_FRESH_FOLD_STRIDE_BARS,
    normalizeFinderAssetFreshFoldSchedule,
    normalizeFinderAssetFoldEnd,
    sliceFinderAssetDataAtFoldEnd,
    sliceFinderAssetDataStrictlyAfterFoldEnd,
    type FinderAssetOpportunityFoldScheduleEntry,
} from "../finder-asset-opportunity-fold";
import { isRustSupportedTradeSizingMode, type CapitalSettings } from "../../types/backtest";
import type {
    FinderAssetOpportunityResult,
    FinderAssetOpportunityDiagnostics,
    FinderDiagnostics,
    FinderDataSlice,
    FinderOptions,
    FinderUniverseCandidate,
} from "../../types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { validateFreshWindowExecutionSettings } from "../finder-asset-opportunity-forward-contract";
import {
    type BatchDatasetLoadContext,
} from "../../batch-backtest/batch-dataset-loader-core";
import { loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import { resolveCapitalSettingsFromRaw } from "../../backtest-capital-settings";
import { requiresTypescriptEngine } from "../../rust-settings-sanitizer";
import {
    clearServerFinderDatasetCaches,
    createServerFinderAssetOpportunityLoadContext,
    getServerFinderDatasetCacheStats,
    loadServerFinderDataset,
} from "./server-finder-data-loader";
import {
    assertCandidateIsScalar,
    toScalarCandidate,
    type FinderJobPhase,
    type FinderRunStatusSnapshot,
    type FinderStreamEvent,
} from "./finder-stream-types";
import { resolveFinderUniverseHeapWarning } from "./finder-server-heap-guard";
import { rememberLoopbackOriginFromRequest } from "../../local-api-transport";
import {
    clampFinderOptions,
    FINDER_BATCH_MAX_BODY_BYTES,
} from "../../server-request-limits";
import { sortFinderUniverseCandidates } from "../finder-universe-metrics";
import {
    buildCombinedUniverseDiagnostics,
    resolveUniverseSortPriority,
} from "../finder-universe-diagnostics-combine";
import {
    runUniverseOosPass,
    resolveUniverseOosSlice,
    type UniverseOosStrategyLookup,
} from "../finder-universe-oos";
import {
    assertAssetOpportunityStrategySelection,
} from "../finder-asset-opportunity-runner";
import {
    normalizeFinderAssetEvalLastBars,
    normalizeFinderAssetOosBatchHoldoutRange,
    normalizeFinderAssetOosHorizons,
    normalizeFinderAssetOosIgnoreLastBars,
} from "../finder-asset-opportunity-oos";
import {
    buildAssetOpportunityPairSummaries,
    buildAssetOpportunityForwardOosBaseline,
    buildAssetOpportunityPerformancePayload,
} from "../finder-asset-opportunity-metadata";
import {
    appendAssetOpportunityArchiveBlock,
    appendAssetOpportunityArchivePairSummary,
    appendAssetOpportunityArchiveFoldIdentities,
    appendAssetOpportunityArchiveRunConfig,
    isAssetOpportunityResearchProgram,
    type AssetOpportunityResearchProgram,
    type AssetOpportunityArchiveAppend,
} from "./finder-asset-opportunity-archive";
import {
    buildFinderAssetOpportunityPairContext,
    type FinderAssetOpportunityCandidateSummaryRow,
    type FinderFreshWindowJudgmentStatus,
} from "./finder-asset-opportunity-research";
import { buildFinderAssetOpportunityControlTrace } from "../finder-asset-opportunity-control-trace";
import { isFinderFreshWindowBatchRole, type FinderFreshWindowBatchRole } from "../finder-asset-opportunity-research-types";
import { captureTradeFilter } from "../finder-config-capture";
import {
    createBufferedFinderRunLogSink,
    resolveFinderRunLogDir,
    type FinderRunLogSink,
} from "./finder-run-log";
import {
    type AnyFinderStreamEvent,
    type FinderAssetOpportunityBatchStreamEvent,
    type FinderAssetOpportunityStreamEvent,
    type FinderAssetOpportunityTotals,
    type FinderBatchStatus,
} from "./finder-stream-types";
import {
    ASSET_OPPORTUNITY_ALL_SORTS,
    getAssetOpportunityResortMetrics,
    sortAssetOpportunityResults,
    sortAssetOpportunityResultsByMetric,
    type FinderAssetOpportunityArchiveSort,
    type FinderAssetOpportunityResortMetric,
} from "../finder-asset-opportunity-metrics";
import {
    runAssetOpportunityIteration,
    type AssetOpportunityIterationCallbacks,
    type AssetOpportunityIterationProgress,
    type AssetOpportunityIterationResult,
    type FinderAssetOpportunityRunInput,
} from "./asset-opportunity-iteration";
import {
    ASSET_OPPORTUNITY_BATCH_WORKER_COUNT_MAX,
    ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP,
    createRealWorkerAssetOpportunityBatchRunner,
    resolveAssetOpportunityBatchWorkerCount,
    runAssetOpportunityBatchSweep,
    type AssetOpportunityBatchRunnerFactory,
    type AssetOpportunityBatchSweepResult,
    type AssetOpportunityBatchWorkerTask,
} from "./finder-asset-opportunity-batch-worker-pool";

// Re-exported for importers (tests, docs) that predate the
// asset-opportunity-iteration leaf extraction.
export {
    runAssetOpportunityIteration,
    type AssetOpportunityIterationProgress,
    type AssetOpportunityIterationAssetResult,
    type AssetOpportunityIterationCallbacks,
    type AssetOpportunityIterationResult,
    type FinderAssetOpportunityRunInput,
} from "./asset-opportunity-iteration";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAP_MB = 1024 * 1024;

/** Bound on run id length (defensive; browser-generated ids are short). */
const MAX_RUN_ID_LENGTH = 128;

/** Asset Opportunity keeps symbol-count and heap guards; candidate work is not preflight-capped. */
const ASSET_OPPORTUNITY_MAX_SYMBOLS = 1_000;

/** Keep a small batch fully occupied when holdoutCount would underfill it. */
const ASSET_OPPORTUNITY_BATCH_PARALLEL_TASK_TARGET = 8;
/** Avoid chunk overhead for tiny test/research universes. */
const ASSET_OPPORTUNITY_BATCH_MIN_CHUNKED_ASSETS = 32;
/** Chunked workers retain only their partition; the resolver still clamps to cores/memory. */
const ASSET_OPPORTUNITY_BATCH_CHUNK_WORKER_TARGET = ASSET_OPPORTUNITY_BATCH_WORKER_COUNT_MAX;

/**
 * Fresh-window identity rows are accumulated only until their ordered fold
 * can be archived. Keep that transient per-task retention bounded; overflow
 * is fatal so a partial identity archive can never be judged as complete.
 */
export const FRESH_WINDOW_SUMMARY_ROWS_PER_TASK_CAP = 100_000;

export function appendFreshWindowSummaryRowsWithinCap(
    target: FinderAssetOpportunityCandidateSummaryRow[],
    rows: readonly FinderAssetOpportunityCandidateSummaryRow[],
): boolean {
    if (target.length + rows.length > FRESH_WINDOW_SUMMARY_ROWS_PER_TASK_CAP) return false;
    target.push(...rows);
    return true;
}

function resolveAssetOpportunityChunkWorkerCount(
    totalIterations: number,
    totalAssets: number,
    env: NodeJS.ProcessEnv,
    systemMemoryBytes: number,
    rustEngine: boolean,
): number {
    let workerCount = resolveAssetOpportunityBatchWorkerCount(
        Math.max(totalIterations, ASSET_OPPORTUNITY_BATCH_CHUNK_WORKER_TARGET),
        totalAssets,
        env,
        systemMemoryBytes,
        {
            rustEngine,
            ...(rustEngine
                ? { rustWorkerCap: ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP }
                : {}),
            taskCount: ASSET_OPPORTUNITY_BATCH_CHUNK_WORKER_TARGET,
            taskSymbolCount: Math.ceil(totalAssets / ASSET_OPPORTUNITY_BATCH_CHUNK_WORKER_TARGET),
        },
    );
    // Recompute the memory estimate from the actual partition size. This
    // converges downward on small-memory hosts while allowing chunked runs to
    // use the CPU available on large-memory hosts.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = resolveAssetOpportunityBatchWorkerCount(
            totalIterations,
            totalAssets,
            env,
            systemMemoryBytes,
            {
                rustEngine,
                ...(rustEngine
                    ? { rustWorkerCap: ASSET_OPPORTUNITY_BATCH_RUST_CHUNK_WORKER_CAP }
                    : {}),
                taskCount: workerCount,
                taskSymbolCount: Math.ceil(totalAssets / workerCount),
            },
        );
        if (next === workerCount) break;
        workerCount = next;
    }
    return Math.max(1, workerCount);
}

function mergeAssetOpportunityChunkResults(
    entries: Array<{
        task: AssetOpportunityBatchWorkerTask;
        iteration: AssetOpportunityIterationResult;
    }>,
    selectedStrategies: FinderSelectedStrategy[],
): AssetOpportunityIterationResult {
    if (entries.length === 0) {
        throw new Error("Cannot merge an empty Asset Opportunity chunk set.");
    }

    const orderedEntries = [...entries].sort(
        (left, right) => (left.task.assetChunkIndex ?? 0) - (right.task.assetChunkIndex ?? 0),
    );
    const strategyOrder = new Map(selectedStrategies.map((strategy, index) => [strategy.key, index]));
    const orderedResults = orderedEntries.flatMap(({ task, iteration }) => {
        const symbolOrder = new Map(task.symbols.map((symbol, index) => [symbol, index]));
        return [...iteration.results].sort((left, right) => {
            const symbolDelta = (symbolOrder.get(left.symbol) ?? Number.MAX_SAFE_INTEGER)
                - (symbolOrder.get(right.symbol) ?? Number.MAX_SAFE_INTEGER);
            if (symbolDelta !== 0) return symbolDelta;
            return (strategyOrder.get(left.strategyKey) ?? Number.MAX_SAFE_INTEGER)
                - (strategyOrder.get(right.strategyKey) ?? Number.MAX_SAFE_INTEGER);
        });
    });
    const results = sortAssetOpportunityResults(orderedResults);
    const diagnostics = orderedEntries.map(({ iteration }) => iteration.assetDiagnostics);
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
    const max = (values: number[]): number => values.reduce((highest, value) => Math.max(highest, value), 0);
    const work = diagnostics.map((diagnostic) => diagnostic.work).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const timings = diagnostics.map((diagnostic) => diagnostic.timingsMs).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const loadedCounts = diagnostics.map((diagnostic) => Math.max(0, diagnostic.totalAssets - diagnostic.failedAssets.length));
    const loadedBarValues = work.map((value) => value.loadedBars).filter((value) => value.max > 0);
    const totalLoadedCount = sum(loadedCounts);
    const loadedBars = loadedBarValues.length > 0
        ? {
            min: Math.min(...loadedBarValues.map((value) => value.min)),
            max: Math.max(...loadedBarValues.map((value) => value.max)),
            avg: totalLoadedCount > 0
                ? Math.round(sum(work.map((value, index) => value.loadedBars.avg * loadedCounts[index]!)) / totalLoadedCount)
                : 0,
        }
        : { min: 0, max: 0, avg: 0 };
    const timingMax = (key: keyof NonNullable<FinderAssetOpportunityDiagnostics["timingsMs"]>): number =>
        max(timings.map((value) => value[key]));
    const timingSum = (key: keyof NonNullable<FinderAssetOpportunityDiagnostics["timingsMs"]>): number =>
        sum(timings.map((value) => value[key]));
    const totalDuration = timingMax("total");
    const dataLoading = timingMax("dataLoading");
    const dataPreparation = timingMax("dataPreparation");
    const inSampleSearch = timingMax("inSampleSearch");
    const freshEntryRechecks = timingMax("freshEntryRechecks");
    const oosValidation = timingMax("oosValidation");
    const resultReduction = timingMax("resultReduction");
    const winnerAnalytics = timingMax("winnerAnalytics");
    const strategyBreakdownByKey = new Map<string, NonNullable<FinderAssetOpportunityDiagnostics["strategyBreakdown"]>[number]>();
    for (const diagnostic of diagnostics) {
        for (const entry of diagnostic.strategyBreakdown ?? []) {
            const existing = strategyBreakdownByKey.get(entry.strategyKey);
            if (!existing) {
                strategyBreakdownByKey.set(entry.strategyKey, { ...entry });
                continue;
            }
            existing.assetsEvaluated += entry.assetsEvaluated;
            existing.candidatesEvaluated += entry.candidatesEvaluated;
            existing.candidateEvaluationsAttempted += entry.candidateEvaluationsAttempted;
            existing.candidateEvaluationsCompleted += entry.candidateEvaluationsCompleted;
            existing.candidateEvaluationFailures += entry.candidateEvaluationFailures;
            existing.freshEntryRechecks += entry.freshEntryRechecks;
            existing.oosEvaluations += entry.oosEvaluations;
            existing.durationMs += entry.durationMs;
        }
    }
    const strategyBreakdown = [...strategyBreakdownByKey.values()]
        .sort((left, right) => right.durationMs - left.durationMs || left.strategyKey.localeCompare(right.strategyKey))
        .slice(0, 10);
    const aggregateStrategyWorkMs = [...strategyBreakdownByKey.values()]
        .reduce((total, entry) => total + entry.durationMs, 0);
    const engineUsage = {
        rustRequested: diagnostics.some((diagnostic) => diagnostic.engineUsage?.rustRequested === true),
        rustAttemptedRuns: sum(diagnostics.map((diagnostic) => diagnostic.engineUsage?.rustAttemptedRuns ?? 0)),
        rustCompletedRuns: sum(diagnostics.map((diagnostic) => diagnostic.engineUsage?.rustCompletedRuns ?? 0)),
        rustFallbackRuns: sum(diagnostics.map((diagnostic) => diagnostic.engineUsage?.rustFallbackRuns ?? 0)),
        typescriptCompletedRuns: sum(diagnostics.map((diagnostic) => diagnostic.engineUsage?.typescriptCompletedRuns ?? 0)),
        typescriptReasons: [] as Array<{ reason: string; runs: number }>,
    };
    const reasonCounts = new Map<string, number>();
    for (const diagnostic of diagnostics) {
        for (const reason of diagnostic.engineUsage?.typescriptReasons ?? []) {
            reasonCounts.set(reason.reason, (reasonCounts.get(reason.reason) ?? 0) + reason.runs);
        }
    }
    engineUsage.typescriptReasons = [...reasonCounts.entries()]
        .map(([reason, runs]) => ({ reason, runs }))
        .sort((left, right) => right.runs - left.runs || left.reason.localeCompare(right.reason));
    const failedAssets = diagnostics.flatMap((diagnostic) => diagnostic.failedAssets);
    const totalAssets = sum(diagnostics.map((diagnostic) => diagnostic.totalAssets));
    const assetsWithFreshEntry = sum(diagnostics.map((diagnostic) => diagnostic.assetsWithFreshEntry));
    const assetsWithNoFreshEntry = sum(diagnostics.map((diagnostic) => diagnostic.assetsWithNoFreshEntry));
    const selectGradeAssets = sum(diagnostics.map((diagnostic) => diagnostic.selectGradeAssets));
    const watchGradeAssets = sum(diagnostics.map((diagnostic) => diagnostic.watchGradeAssets));
    const rejectGradeAssets = sum(diagnostics.map((diagnostic) => diagnostic.rejectGradeAssets));
    const loaderDiagnostics = diagnostics.map((diagnostic) => diagnostic.loader).filter(
        (value): value is NonNullable<FinderAssetOpportunityDiagnostics["loader"]> => Boolean(value),
    );
    const loader = loaderDiagnostics.length > 0
        ? {
            requests: sum(loaderDiagnostics.map((value) => value.requests)),
            syntheticPairRequests: sum(loaderDiagnostics.map((value) => value.syntheticPairRequests)),
            pairCacheHits: sum(loaderDiagnostics.map((value) => value.pairCacheHits)),
            pairCacheMisses: sum(loaderDiagnostics.map((value) => value.pairCacheMisses)),
            diskCacheHits: sum(loaderDiagnostics.map((value) => value.diskCacheHits)),
            diskCacheMisses: sum(loaderDiagnostics.map((value) => value.diskCacheMisses)),
            legCacheHits: sum(loaderDiagnostics.map((value) => value.legCacheHits)),
            legCacheMisses: sum(loaderDiagnostics.map((value) => value.legCacheMisses)),
            sourceLoads: sum(loaderDiagnostics.map((value) => value.sourceLoads)),
            sourceBarsRequested: sum(loaderDiagnostics.map((value) => value.sourceBarsRequested)),
            sourceBarsLoaded: sum(loaderDiagnostics.map((value) => value.sourceBarsLoaded)),
            pairBuilds: sum(loaderDiagnostics.map((value) => value.pairBuilds)),
            diskCacheBypasses: sum(loaderDiagnostics.map((value) => value.diskCacheBypasses)),
            timingsMs: {
                total: sum(loaderDiagnostics.map((value) => value.timingsMs.total)),
                fingerprint: sum(loaderDiagnostics.map((value) => value.timingsMs.fingerprint)),
                diskLookup: sum(loaderDiagnostics.map((value) => value.timingsMs.diskLookup)),
                sourceLoads: sum(loaderDiagnostics.map((value) => value.timingsMs.sourceLoads)),
                pairBuild: sum(loaderDiagnostics.map((value) => value.timingsMs.pairBuild)),
                pairWrite: sum(loaderDiagnostics.map((value) => value.timingsMs.pairWrite)),
            },
        }
        : undefined;
    const slowestAssets = diagnostics.flatMap((diagnostic) => diagnostic.slowestAssets ?? [])
        .sort((left, right) => right.timingsMs.total - left.timingsMs.total)
        .slice(0, 10);
    const assetDiagnostics: FinderAssetOpportunityDiagnostics = {
        totalAssets,
        assetsWithFreshEntry,
        assetsWithNoFreshEntry,
        selectGradeAssets,
        watchGradeAssets,
        rejectGradeAssets,
        failedAssets,
        work: {
            selectedStrategies: work[0]?.selectedStrategies ?? selectedStrategies.length,
            candidateEvaluationsEstimated: sum(work.map((value) => value.candidateEvaluationsEstimated)),
            candidateEvaluationsAttempted: sum(work.map((value) => value.candidateEvaluationsAttempted)),
            candidateEvaluationsCompleted: sum(work.map((value) => value.candidateEvaluationsCompleted)),
            candidateEvaluationFailures: sum(work.map((value) => value.candidateEvaluationFailures)),
            signalCacheHits: sum(work.map((value) => value.signalCacheHits)),
            signalCacheMisses: sum(work.map((value) => value.signalCacheMisses)),
            freshEntryRechecks: sum(work.map((value) => value.freshEntryRechecks)),
            oosEvaluations: sum(work.map((value) => value.oosEvaluations)),
            winnerAnalyticsRecomputations: sum(work.map((value) => value.winnerAnalyticsRecomputations)),
            loadedBars,
        },
        timingsMs: {
            total: totalDuration,
            dataLoading,
            dataPreparation,
            inSampleSearch,
            parameterGeneration: timingSum("parameterGeneration"),
            candidateBacktests: timingSum("candidateBacktests"),
            freshEntryRechecks,
            oosValidation,
            resultReduction,
            winnerAnalytics,
            yielding: timingMax("yielding"),
            other: Math.max(0, totalDuration - dataLoading - dataPreparation - inSampleSearch
                - freshEntryRechecks - oosValidation - resultReduction - winnerAnalytics),
        },
        timingSummary: {
            wallClockMs: totalDuration,
            aggregateStrategyWorkMs,
            parallelism: totalDuration > 0
                ? Number((aggregateStrategyWorkMs / totalDuration).toFixed(2))
                : 0,
        },
        ...(loader ? { loader } : {}),
        strategyBreakdown,
        slowestAssets,
        engineUsage,
    };
    const mergedTotals: FinderAssetOpportunityTotals = {
        totalAssets,
        assetsWithFreshEntry,
        selectGradeAssets,
        watchGradeAssets,
        rejectGradeAssets,
        failedAssets: failedAssets.length,
        engineUsage,
    };
    const foldMetadataValues = orderedEntries
        .map(({ iteration }) => iteration.foldMetadata)
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const foldMetadata = foldMetadataValues.length > 0
        ? {
            foldEnd: foldMetadataValues[0]!.foldEnd,
            searchWindowEnd: foldMetadataValues.reduce<number | null>(
                (current, value) => value.searchWindowEnd === null
                    ? current
                    : Math.max(current ?? value.searchWindowEnd, value.searchWindowEnd),
                null,
            ),
            oosStart: foldMetadataValues.reduce<number | null>(
                (current, value) => value.oosStart === null
                    ? current
                    : Math.min(current ?? value.oosStart, value.oosStart),
                null,
            ),
            oosEnd: foldMetadataValues.reduce<number | null>(
                (current, value) => value.oosEnd === null
                    ? current
                    : Math.max(current ?? value.oosEnd, value.oosEnd),
                null,
            ),
        }
        : undefined;
    return {
        results,
        cancelled: entries.some(({ iteration }) => iteration.cancelled),
        assetDiagnostics,
        totals: mergedTotals,
        summary: `Asset Opportunity complete: ${results.length}/${totalAssets} fresh opportunities (${selectGradeAssets} select, ${watchGradeAssets} watch, ${rejectGradeAssets} reject, ${assetsWithNoFreshEntry} no fresh, ${failedAssets.length} failed).`,
        ...(entries.some(({ iteration }) => iteration.expectedCandidateSummaryRows !== undefined)
            ? {
                expectedCandidateSummaryRows: entries.reduce(
                    (total, { iteration }) => total + (iteration.expectedCandidateSummaryRows ?? 0),
                    0,
                ),
            }
            : {}),
        ...(foldMetadata ? { foldMetadata } : {}),
    };
}

// Stateless param-space generator (no constructor args, no browser deps).
// Module-scope so it's reused across requests, mirroring FinderManager.paramSpace.
const paramSpace = new FinderParamSpace();

// ---------------------------------------------------------------------------
// Module-scope state — single in-flight run per dev server (single-owner model)
// ---------------------------------------------------------------------------

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGen = 0;

let runState: FinderRunSnapshot | null = null;
let abortController: AbortController | null = null;

/**
 * Stop-before-ownership race closer. When Stop arrives BEFORE the matching
 * run acquires ownership (the request is still parsing / validating), the
 * run id is recorded here. The matching run request consumes the marker and
 * finishes cancelled instead of starting heavy work. This closes the race
 * without retaining an unbounded cancellation set (only the latest pending
 * stop run id is retained).
 */
let pendingStopRunId: string | null = null;

/**
 * Deferred dataset-cache invalidation (bounded boolean, not a queue). Data
 * sync completion POSTs /api/finder/invalidate-cache; while a run owns the
 * server, clearing shared data caches mid-run would mix pre-sync and post-sync
 * datasets inside one job. The request is acknowledged as deferred and flushed
 * at a generation-safe run boundary (before the next run begins, or when the
 * owning run releases normally).
 */
let pendingDatasetCacheInvalidation = false;

/**
 * Apply a deferred dataset-cache invalidation at a generation-safe run
 * boundary. No-op when nothing was deferred. Must only be called when no
 * run can be mid-flight on the datasets being cleared: at ownership
 * acquisition (before the new run loads anything) or when the owning run
 * releases normally (no newer owner exists).
 */
function flushPendingDatasetCacheInvalidation(): void {
    if (!pendingDatasetCacheInvalidation) return;
    pendingDatasetCacheInvalidation = false;
    clearServerFinderDatasetCaches();
    debugLogger.event("finder.server.dataset_cache_invalidation_flushed");
}

/**
 * Acquire single-owner run ownership. Flushes any deferred dataset-cache
 * invalidation first so the new run cannot load pre-sync datasets.
 */
function acquireRunOwnership(): number {
    flushPendingDatasetCacheInvalidation();
    const owner = ++runOwnerGen;
    runOwner = owner;
    return owner;
}

export type FinderRunSnapshot = {
    runId: string;
    startedAt: number;
    /** Set when the run reaches a terminal snapshot (done/cancelled/fatal). */
    finishedAt: number | null;
    interval: string;
    /** Job kind discriminator; defaults to symbol_universe for legacy state. */
    jobKind?: "symbol_universe" | "asset_opportunity" | "asset_opportunity_batch";
    /** Research archive namespace, present only for an explicit program. */
    researchProgram?: AssetOpportunityResearchProgram;
    judgmentStatus?: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons?: string[];
    /** Point-in-time fold boundary, present only for a declared fold. */
    foldEnd?: number;
    /** Ordered selected entry strategy keys for the whole job. */
    strategyKeys: string[];
    /** 0-based index of the strategy currently being evaluated. */
    strategyIndex: number;
    strategyCount: number;
    phase: FinderJobPhase;
    totalSymbols: number;
    progressPercent: number;
    statusText: string;
    loadedSymbols: number;
    failedSymbols: number;
    /** Surviving candidates accumulated so far (scalar-only). */
    candidates: FinderUniverseCandidate[];
    /** All Asset Opportunity rows accumulated so far (scalar-only). */
    assetResults?: FinderAssetOpportunityResult[];
    /** Terminal diagnostics once the run finishes; null while in flight. */
    diagnostics: FinderDiagnostics | null;
    cancelled: boolean;
    /** Final summary string; populated on done. */
    summary: string | null;
    /** Terminal fatal error; null for running, done, and cancelled jobs. */
    error: string | null;
    totals: {
        loadedSymbols: number;
        failedSymbols: number;
        survivors: number;
        oosRemoved: number;
    } | null;
    assetTotals?: {
        totalAssets: number;
        assetsWithFreshEntry: number;
        selectGradeAssets: number;
        watchGradeAssets: number;
        rejectGradeAssets: number;
        failedAssets: number;
        engineUsage?: FinderAssetOpportunityDiagnostics["engineUsage"];
    } | null;
    /** Terminal Asset Opportunity diagnostics retained for reload reattach. */
    assetDiagnostics?: FinderAssetOpportunityDiagnostics | null;
    /** Bounded batch counts for asset_opportunity_batch jobs; undefined otherwise. */
    batch?: FinderBatchStatus;
};

// ---------------------------------------------------------------------------
// Run core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: FinderStreamEvent) => void;

function writeStreamEventBestEffort(
    stream: { write(event: AnyFinderStreamEvent): void },
    event: AnyFinderStreamEvent,
    runId: string,
): boolean {
    try {
        stream.write(event);
        return true;
    } catch (error) {
        debugLogger.warn("finder.server.stream_write_lost", {
            runId,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

function consumePendingStopForRun(runId: string): boolean {
    if (pendingStopRunId !== runId) return false;
    pendingStopRunId = null;
    return true;
}

/**
 * Arguments for {@link processFinderUniverseRun}. Mirrors the shape the
 * browser `FinderManager.runUniverseFinder` builds for
 * `runFinderUniverseExecution`, plus `useRustEnginePreference` (the
 * documented Rust-engine-trap fix) and the universe `symbols` list (which the
 * browser reads from the DOM).
 *
 * Multi-strategy: `selectedStrategies` is the ordered list of entry
 * strategies to sequence. The runner core takes ONE strategy per invocation,
 * so the plugin loops over this list and merges survivors by identity.
 */
export interface FinderUniverseServerRunInput {
    runId: string;
    interval: string;
    symbols: string[];
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    /** Ordered entry strategies to sequence in this job. */
    selectedStrategies: FinderSelectedStrategy[];
    /** Candidate exit strategies Finder may sample for Exit Strategy Override. */
    exitStrategyCandidates?: FinderSelectedStrategy[];
    /**
     * Mirrors the user's Rust-engine UI toggle. Optional to match
     * {@link FinderUniverseRunInput.useRustEnginePreference} so tests can omit
     * it; the production HTTP handler always sets it from the request body.
     * See `shouldAttemptRust` for the Node-path semantics.
     */
    useRustEnginePreference?: boolean;
    /** Server owner abort signal, used by the post-IS OOS loader. */
    abortSignal?: AbortSignal;
    /**
     * IS data loader. Tests inject a stub; production wires
     * {@link loadServerFinderDataset}. Decoupled so the core is testable
     * without the dev server. The caller applies the IS data slice.
     */
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    /**
     * OOS data loader (raw series; the OOS slice is applied by the wrapper
     * built in {@link processFinderUniverseRun}). When omitted, OOS is
     * skipped (tests that do not exercise OOS). Production wires
     * {@link loadServerFinderDataset}.
     */
    loadOosDataset?: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    /**
     * Optional override for `generateParamSets` (tests inject a deterministic
     * generator). Production wires the FinderManager param-space generator.
     */
    generateParamSets?: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    /** Provider lookup for cross-symbol strategies. */
    getProvider?: (symbol: string) => string;
}

/**
 * Core universe job, factored out of the HTTP handler so it can be tested
 * with a stubbed loader and writer without spinning up Vite. Mirrors
 * `processRunBatch` in the Batch plugin.
 *
 * `owner` keys cancellation: every strategy + OOS loop bails as soon as
 * `runOwner !== owner` (Stop force-bumped the lock or a newer run took it).
 * The shared `abortController` cancels in-flight dataset loads.
 *
 * Parity: this is a THIN WRAPPER over `runFinderUniverseExecution`. The same
 * core that powers the browser path powers the server path; the only
 * difference is the `loadDataset` callback and the multi-strategy sequencing
 * loop. Determinism and browser/server result parity come from reusing the
 * core plus the extracted OOS leaf.
 */
export async function processFinderUniverseRun(
    input: FinderUniverseServerRunInput,
    writer: StreamWriter,
    owner: number,
): Promise<void> {
    const symbols = input.symbols;
    const totalSymbols = symbols.length;
    const selectedStrategies = input.selectedStrategies;
    const strategyCount = selectedStrategies.length;
    const candidatePlansEstimate = estimateCandidateCount(input);
    const sortPriority = resolveUniverseSortPriority(input.options);
    // Every selected strategy evaluates the same universe. Cache only
    // successful sliced datasets for this server job so the loader performs
    // one real read/build per symbol+interval instead of one per strategy.
    // Failures and empty results are removed so a later strategy may retry.
    const jobDatasetCache = new Map<string, Promise<OHLCVData[]>>();
    const jobReadyDatasetCache = new Map<string, OHLCVData[]>();
    const jobDatasetCacheStats = {
        requests: 0,
        hits: 0,
        misses: 0,
        successfulLoads: 0,
        failedLoads: 0,
        uniqueBarsLoaded: 0,
    };
    const slowestDatasetLoads: Array<{
        symbol: string;
        interval: string;
        ms: number;
        bars: number;
    }> = [];
    const recordDatasetLoad = (symbol: string, interval: string, ms: number, bars: number): void => {
        slowestDatasetLoads.push({
            symbol,
            interval,
            ms: Math.round(ms * 10) / 10,
            bars,
        });
        slowestDatasetLoads.sort((a, b) => b.ms - a.ms);
        if (slowestDatasetLoads.length > 8) slowestDatasetLoads.length = 8;
    };
    const loadDatasetForJob = (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
    ): Promise<OHLCVData[]> => {
        jobDatasetCacheStats.requests += 1;
        if (signal?.aborted) return Promise.resolve([]);
        const key = `${symbol}|${interval}`;
        const cached = jobDatasetCache.get(key);
        if (cached) {
            jobDatasetCacheStats.hits += 1;
            return cached;
        }

        jobDatasetCacheStats.misses += 1;
        let promise: Promise<OHLCVData[]>;
        const loadStartedAt = performance.now();
        promise = Promise.resolve()
            .then(() => input.loadDataset(symbol, interval, signal))
            .then((data) => {
                if (signal?.aborted || data.length === 0) {
                    if (jobDatasetCache.get(key) === promise) jobDatasetCache.delete(key);
                    if (!signal?.aborted) jobDatasetCacheStats.failedLoads += 1;
                    return data;
                }
                jobDatasetCacheStats.successfulLoads += 1;
                jobDatasetCacheStats.uniqueBarsLoaded += data.length;
                jobReadyDatasetCache.set(key, data);
                recordDatasetLoad(symbol, interval, performance.now() - loadStartedAt, data.length);
                return data;
            })
            .catch((error) => {
                if (jobDatasetCache.get(key) === promise) jobDatasetCache.delete(key);
                jobDatasetCacheStats.failedLoads += 1;
                throw error;
            });
        jobDatasetCache.set(key, promise);
        return promise;
    };

    runState = {
        runId: input.runId,
        startedAt: Date.now(),
        finishedAt: null,
        interval: input.interval,
        jobKind: "symbol_universe",
        strategyKeys: selectedStrategies.map((s) => s.key),
        strategyIndex: 0,
        strategyCount,
        phase: "loading",
        totalSymbols,
        progressPercent: 0,
        statusText: "Starting...",
        loadedSymbols: 0,
        failedSymbols: 0,
        candidates: [],
        assetResults: [],
        diagnostics: null,
        cancelled: false,
        summary: null,
        error: null,
        totals: null,
        assetTotals: null,
    };
    const snapshot = runState;

    writer({
        type: "start",
        runId: input.runId,
        totalCandidates: candidatePlansEstimate,
        totalSymbols,
        interval: input.interval,
        strategyKeys: selectedStrategies.map((s) => s.key),
        strategyCount,
    });

    const lostOwnership = () => runOwner !== owner;
    // Completed strategies and the active strategy are tracked separately.
    // `onResultsUpdate` is a replacement snapshot, not an append-only stream:
    // retaining candidates evicted from a later top-K update would keep their
    // per-symbol arrays alive for the rest of the job.
    const completedSurvivorByKey = new Map<string, FinderUniverseCandidate>();
    let activeSurvivorByKey = new Map<string, FinderUniverseCandidate>();
    const emittedKeys = new Set<string>();
    const identityKey = (c: FinderUniverseCandidate) =>
        `${c.strategyKey}|${JSON.stringify(c.params)}|${c.exitStrategyKey ?? ""}|${JSON.stringify(c.exitStrategyParams ?? {})}`;

    // Per-strategy diagnostics parts; combined into one job-level diagnostics
    // object at the terminal event.
    const diagnosticsParts: FinderDiagnostics[] = [];
    let loadedSymbolsMax = 0;
    // Unique failing symbols across the whole job. A symbol that fails to load
    // typically fails for every selected strategy; summing `failedSymbols.length`
    // per strategy double-counts the same N symbols once per strategy. Track a
    // set for the user-facing total and a raw attempt counter for diagnostics.
    const failedSymbolSet = new Set<string>();
    let failedLoadAttempts = 0;
    let cancelled = false;
    let oosRemoved = 0;

    const rankAndBound = (candidates: readonly FinderUniverseCandidate[]): FinderUniverseCandidate[] =>
        sortFinderUniverseCandidates(candidates, sortPriority).slice(0, input.options.topN);

    const replaceActiveSurvivors = (results: readonly FinderUniverseCandidate[]): void => {
        activeSurvivorByKey = new Map(results.map((candidate) => [identityKey(candidate), candidate]));
        snapshot.candidates = rankAndBound([
            ...completedSurvivorByKey.values(),
            ...activeSurvivorByKey.values(),
        ]);
    };

    const emitProgress = (phase: FinderJobPhase, percent: number, text: string): void => {
        if (lostOwnership()) return;
        snapshot.phase = phase;
        snapshot.progressPercent = percent;
        snapshot.statusText = text;
        writer({ type: "progress", percent, text, status: text, phase, strategyIndex: snapshot.strategyIndex, strategyCount });
    };

    try {
        for (let strategyIndex = 0; strategyIndex < strategyCount; strategyIndex += 1) {
            if (lostOwnership()) {
                cancelled = true;
                break;
            }
            const selectedStrategy = selectedStrategies[strategyIndex]!;
            snapshot.strategyIndex = strategyIndex;
            snapshot.phase = "loading";
            emitProgress(
                "loading",
                scaleProgressAcrossStrategies(strategyIndex, 0, strategyCount),
                `Strategy ${strategyIndex + 1}/${strategyCount}: ${selectedStrategy.name} — loading...`,
            );

            // The runner emits per-symbol progress in 0-100 within one
            // strategy; scale it across the multi-strategy job so the bar is
            // monotonic. Track the latest in-strategy percent for setStatus
            // (which the runner emits per-symbol without a percent).
            let inStrategyPercent = 0;
            const output = await runFinderUniverseExecution(
                {
                    interval: input.interval,
                    options: input.options,
                    settings: input.settings,
                    capitalSettings: input.capitalSettings,
                    selectedStrategy,
                    loadDataset: loadDatasetForJob,
                    getCachedDataset: (symbol, interval) => {
                        const cached = jobReadyDatasetCache.get(`${symbol}|${interval}`);
                        if (cached) {
                            // Keep cache diagnostics comparable with the
                            // previous path even though this hit now bypasses
                            // the runner's async load orchestration entirely.
                            jobDatasetCacheStats.requests += 1;
                            jobDatasetCacheStats.hits += 1;
                        }
                        return cached;
                    },
                    getProvider: input.getProvider,
                    generateParamSets: input.generateParamSets ?? (() => []),
                    exitStrategyCandidates: input.exitStrategyCandidates,
                    useRustEnginePreference: input.useRustEnginePreference,
                },
                {
                    setProgress: (percent, text) => {
                        inStrategyPercent = percent;
                        emitProgress(
                            "evaluating",
                            scaleProgressAcrossStrategies(strategyIndex, percent, strategyCount),
                            text,
                        );
                    },
                    setStatus: (text) => {
                        emitProgress(
                            snapshot.phase === "loading" ? "loading" : "evaluating",
                            scaleProgressAcrossStrategies(strategyIndex, inStrategyPercent, strategyCount),
                            text,
                        );
                    },
                    yieldControl: async () => {
                        // Actually yield to the Node event loop so pending
                        // control requests (/api/finder/stop, /status,
                        // /api/sqlite/*) get serviced.
                        await new Promise<void>((resolve) => setImmediate(resolve));
                    },
                    isCancelled: () => {
                        if (lostOwnership()) {
                            cancelled = true;
                            return true;
                        }
                        return false;
                    },
                    onResultsUpdate: (results) => {
                        if (lostOwnership()) return;
                        replaceActiveSurvivors(results);
                        // Emit ONLY candidates whose identity has not been
                        // streamed yet. The terminal `done.candidates` slice
                        // is authoritative, so skipping a re-emit cannot drop
                        // a survivor.
                        for (const candidate of results) {
                            const key = identityKey(candidate);
                            if (emittedKeys.has(key)) continue;
                            emittedKeys.add(key);
                            const scalar = toScalarCandidate(candidate);
                            assertCandidateIsScalar(scalar);
                            const idx = snapshot.candidates.findIndex((c) => identityKey(c) === key);
                            writer({
                                type: "candidate",
                                index: idx,
                                totalCandidates: candidatePlansEstimate,
                                candidate: scalar,
                            });
                        }
                    },
                },
            );

            if (lostOwnership()) {
                cancelled = true;
                if (runState === snapshot) snapshot.cancelled = true;
                break;
            }

            // The runner's terminal slice replaces every incremental snapshot
            // for this strategy. Merge it into the bounded completed set, then
            // release the active set before the next strategy starts.
            activeSurvivorByKey = new Map(
                output.results.map((candidate) => [identityKey(candidate), candidate]),
            );
            for (const candidate of output.results) {
                completedSurvivorByKey.set(identityKey(candidate), candidate);
            }
            const boundedCompleted = rankAndBound([...completedSurvivorByKey.values()]);
            completedSurvivorByKey.clear();
            for (const candidate of boundedCompleted) {
                completedSurvivorByKey.set(identityKey(candidate), candidate);
            }
            activeSurvivorByKey.clear();
            loadedSymbolsMax = Math.max(loadedSymbolsMax, output.loadedSymbols);
            for (const failed of output.failedSymbols) failedSymbolSet.add(failed);
            failedLoadAttempts += output.failedSymbols.length;
            if (output.diagnostics) diagnosticsParts.push(output.diagnostics);

            // Re-sort + bound the merged snapshot to topN so `runState` never
            // retains candidates that would later be evicted.
            snapshot.candidates = [...boundedCompleted];

            snapshot.loadedSymbols = loadedSymbolsMax;
            snapshot.failedSymbols = failedSymbolSet.size;

            debugLogger.event("finder.server.strategy.complete", {
                runId: input.runId,
                strategyKey: selectedStrategy.key,
                strategyIndex,
                strategyCount,
                loadedSymbols: output.loadedSymbols,
                failedSymbols: output.failedSymbols.length,
                uniqueFailedSymbols: failedSymbolSet.size,
                survivors: output.results.length,
                mergedSurvivors: snapshot.candidates.length,
                durationMs: Date.now() - snapshot.startedAt,
            });
        }

        // Job-level merged IS survivors (authoritative, sorted + bounded).
        let terminalResults = rankAndBound([
            ...completedSurvivorByKey.values(),
            ...activeSurvivorByKey.values(),
        ]);

        if (!cancelled && !lostOwnership() && input.options.oosValidationEnabled && input.loadOosDataset) {
            snapshot.phase = "oos";
            snapshot.strategyIndex = strategyCount; // OOS is post-strategy
            const oosSlice = resolveUniverseOosSlice(input.options.dataSlice);
            if (oosSlice) {
                const strategyByKey: UniverseOosStrategyLookup = new Map(
                    selectedStrategies.map((s) => [s.key, s.strategy]),
                );
                // OOS loader wrapper: apply the OOS data slice EXACTLY ONCE.
                // Cache the sliced series per symbol so the same symbol is not
                // re-sliced across candidates/strategies (mirrors the prior
                // browser `loadOosData` closure with its local cache).
                const oosCache = new Map<string, OHLCVData[]>();
                const loadOosSliced = async (symbol: string, interval: string): Promise<OHLCVData[]> => {
                    const cacheKey = `${symbol.trim().toUpperCase()}|${interval}`;
                    const cached = oosCache.get(cacheKey);
                    if (cached) return cached;
                    try {
                        const full = await input.loadOosDataset!(symbol, interval, input.abortSignal);
                        const sliced = sliceFinderDataWindow(full, oosSlice);
                        oosCache.set(cacheKey, sliced);
                        return sliced;
                    } catch {
                        oosCache.set(cacheKey, []);
                        return [];
                    }
                };
                snapshot.candidates = terminalResults;
                const oosResult = await runUniverseOosPass({
                    results: terminalResults,
                    strategyByKey,
                    settings: input.settings,
                    options: input.options,
                    capitalSettings: input.capitalSettings,
                    interval: input.interval,
                    loadOosData: loadOosSliced,
                    getProvider: input.getProvider,
                    useRustEnginePreference: input.useRustEnginePreference,
                    isCancelled: () => {
                        if (lostOwnership()) {
                            cancelled = true;
                            return true;
                        }
                        return false;
                    },
                    onProgress: (percent, text) => {
                        emitProgress("oos", percent, text);
                    },
                    yieldControl: async () => {
                        await new Promise<void>((resolve) => setImmediate(resolve));
                    },
                });
                oosRemoved = oosResult.oosRemoved;
                cancelled = cancelled || oosResult.cancelled;
                // runUniverseOosPass mutates terminalResults in place.
                terminalResults = snapshot.candidates;
                debugLogger.event("finder.server.oos.complete", {
                    runId: input.runId,
                    oosRemoved,
                    survivors: terminalResults.length,
                    durationMs: Date.now() - snapshot.startedAt,
                });
            }
        }

        if (lostOwnership()) {
            cancelled = true;
            if (runState === snapshot) snapshot.cancelled = true;
        }

        const terminalScalar = terminalResults.map(toScalarCandidate);
        for (const scalar of terminalScalar) {
            assertCandidateIsScalar(scalar);
        }
        snapshot.candidates = terminalScalar;
        snapshot.phase = cancelled ? "cancelled" : "done";
        snapshot.finishedAt = Date.now();

        const combinedDiagnostics =
            diagnosticsParts.length === 0
                ? null
                : diagnosticsParts.length === 1
                    ? diagnosticsParts[0]!
                    : buildCombinedUniverseDiagnostics({
                        mode: input.options.mode,
                        interval: input.interval,
                        parts: diagnosticsParts,
                        shownResults: terminalScalar.length,
                        elapsedMs: Date.now() - snapshot.startedAt,
                    });
        if (combinedDiagnostics?.universe) {
            combinedDiagnostics.universe.jobDatasetCache = {
                ...jobDatasetCacheStats,
                entries: jobDatasetCache.size,
                slowestLoads: slowestDatasetLoads,
            };
        }
        snapshot.diagnostics = combinedDiagnostics;

        const summary = cancelled
            ? `Cancelled — ${terminalScalar.length} survivors`
            : `Done — ${terminalScalar.length} survivors, ${failedSymbolSet.size} failed symbols`;
        snapshot.summary = summary;
        snapshot.totals = {
            loadedSymbols: loadedSymbolsMax,
            failedSymbols: failedSymbolSet.size,
            survivors: terminalScalar.length,
            oosRemoved,
        };

        writer({
            type: "done",
            ok: !cancelled,
            cancelled,
            runId: input.runId,
            interval: input.interval,
            totals: {
                loadedSymbols: loadedSymbolsMax,
                failedSymbols: failedSymbolSet.size,
                survivors: terminalScalar.length,
                oosRemoved,
            },
            candidates: terminalScalar,
            summary,
            diagnostics: combinedDiagnostics,
            cacheStats: getServerFinderDatasetCacheStats(),
        });

        debugLogger.event("finder.server.run.complete", {
            runId: input.runId,
            symbols: totalSymbols,
            strategyCount,
            loadedSymbols: loadedSymbolsMax,
            failedSymbols: failedSymbolSet.size,
            failedLoadAttempts,
            survivors: terminalScalar.length,
            oosRemoved,
            cancelled,
            durationMs: Date.now() - snapshot.startedAt,
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / HEAP_MB),
            heapLimitMb: Math.floor(getHeapStatistics().heap_size_limit / HEAP_MB),
            interval: input.interval,
            strategyKeys: selectedStrategies.map((s) => s.key),
            jobDatasetCache: {
                ...jobDatasetCacheStats,
                entries: jobDatasetCache.size,
                slowestLoads: slowestDatasetLoads,
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        snapshot.phase = "fatal";
        snapshot.finishedAt = Date.now();
        snapshot.statusText = `Finder failed: ${message}`;
        snapshot.summary = snapshot.statusText;
        snapshot.error = message;
        snapshot.totals = {
            loadedSymbols: loadedSymbolsMax,
            failedSymbols: failedSymbolSet.size,
            survivors: snapshot.candidates.length,
            oosRemoved,
        };
        debugLogger.warn("finder.server.run.fatal", { runId: input.runId, error: message });
        writer({ type: "fatal", runId: input.runId, error: message });
    } finally {
        jobDatasetCache.clear();
    }
}

/**
 * Scale a 0-100 in-strategy percent across the multi-strategy job so the
 * progress bar is monotonic across the whole sequence.
 */
function scaleProgressAcrossStrategies(strategyIndex: number, inStrategyPercent: number, strategyCount: number): number {
    if (strategyCount <= 1) return inStrategyPercent;
    const base = (strategyIndex / strategyCount) * 100;
    const span = (1 / strategyCount) * 100;
    return Math.min(100, base + (inStrategyPercent / 100) * span);
}

/**
 * Rough estimate of the candidate-plan count for the `start` event. Mirrors
 * the browser status text ("Evaluating candidate N/M"). The exact count is
 * derived inside the runner from the param space; without re-running the
 * generator we approximate from `options.maxRuns`, which is the upper bound
 * for random mode (the only mode Universe supports), times the strategy count.
 */
function estimateCandidateCount(input: FinderUniverseServerRunInput): number {
    const perStrategy = Math.max(1, Math.floor(input.options.maxRuns ?? 1));
    return perStrategy * Math.max(1, input.selectedStrategies.length);
}

// ---------------------------------------------------------------------------
// Asset Opportunity job core
// ---------------------------------------------------------------------------

interface FinderAssetOpportunityRequestBody {
    symbols: unknown;
    interval: unknown;
    options: unknown;
    settings: unknown;
    capitalSettings: unknown;
    /** Preferred multi-strategy selection. */
    strategyKeys?: unknown;
    /** Legacy single-strategy field, normalized to a one-item list. */
    strategyKey?: unknown;
    runId?: unknown;
    exitStrategyKeys?: unknown;
    useRustEnginePreference?: unknown;
    providerBySymbol?: unknown;
    /** Legacy field accepted for compatibility; batch archives always use All Sorts. */
    archiveSort?: unknown;
    /** Optional allowlisted research archive program. */
    researchProgram?: unknown;
    /** Optional point-in-time fold boundary (last usable candle timestamp). */
    foldEnd?: unknown;
    /** Explicit 25-entry fresh-window fold schedule. */
    foldSchedule?: unknown;
    /** Required role for a fresh-window batch budget. */
    batchRole?: unknown;
}

/**
 * Ascending holdout values for a validated inclusive batch range. The range
 * is validated before ownership is acquired; this helper only enumerates.
 */
export function buildAssetOpportunityBatchHoldoutValues(
    startHoldoutBars: number,
    endHoldoutBars: number,
): number[] {
    const values: number[] = [];
    for (let value = startHoldoutBars; value <= endHoldoutBars; value += 1) {
        values.push(value);
    }
    return values;
}

/**
 * Time/percent-delta throttle for high-frequency `asset_progress` /
 * `asset_batch_progress` STREAM writes. The UI shows one aggregate percentage,
 * but progress callbacks fire ~4x per (asset x strategy) pass — a large batch
 * emits hundreds of thousands of events otherwise. Snapshot mirroring stays
 * per-event (so `/status` reattach stays fully fresh); only the NDJSON write
 * is gated. Emits on: first call, >= thresholdMs since the last write,
 * >= minPercentDelta change, or any phase transition. Terminal and iteration
 * events are separate event types and never pass through here.
 */
export function createProgressEventThrottle(thresholdMs = 250, minPercentDelta = 1): (sample: {
    percent: number;
    phase: string;
    write: () => void;
}) => void {
    let lastEmitAt = 0;
    let lastEmittedPercent = Number.NaN;
    let lastEmittedPhase = "";
    return (sample) => {
        const now = Date.now();
        const phaseChanged = sample.phase !== lastEmittedPhase;
        const percentDelta = Math.abs(sample.percent - lastEmittedPercent);
        if (
            lastEmitAt !== 0
            && !phaseChanged
            && now - lastEmitAt < thresholdMs
            && !(percentDelta >= minPercentDelta)
        ) {
            return;
        }
        lastEmitAt = now;
        lastEmittedPercent = sample.percent;
        lastEmittedPhase = sample.phase;
        sample.write();
    };
}

/**
 * Process ONE Asset Opportunity job (single run). Preserves the existing
 * events and status behavior exactly: initializes the asset-opportunity
 * snapshot, emits `asset_start`, runs the shared iteration seam once,
 * mirrors progress onto the snapshot + `asset_progress` events, streams each
 * scalar asset via `asset_complete`, and terminates with `asset_done`.
 */
async function runFinderAssetOpportunityWorkerSweep(
    input: FinderAssetOpportunityRunInput & {
        batchTaskRunnerFactory: AssetOpportunityBatchRunnerFactory;
        assetWorkerCount: number;
        providerBySymbol?: Record<string, string>;
    },
    callbacks: AssetOpportunityIterationCallbacks,
    isCancelled: () => boolean,
): Promise<AssetOpportunityIterationResult> {
    const totalAssets = input.symbols.length;
    const chunkCount = Math.max(1, Math.min(input.assetWorkerCount, totalAssets));
    const chunkSize = Math.ceil(totalAssets / chunkCount);
    const providerBySymbol = input.providerBySymbol ?? {};
    const tasks: AssetOpportunityBatchWorkerTask[] = Array.from({ length: chunkCount }, (_, assetChunkIndex) => {
        const symbols = input.symbols.slice(assetChunkIndex * chunkSize, (assetChunkIndex + 1) * chunkSize);
        const options = input.options.assetOpportunity
            ? {
                ...input.options,
                assetOpportunity: {
                    ...input.options.assetOpportunity,
                    symbols,
                },
            }
            : input.options;
        return {
            taskIndex: assetChunkIndex,
            holdoutBars: 0,
            assetChunkIndex,
            assetChunkCount: chunkCount,
            runId: input.runId,
            interval: input.interval,
            symbols,
            options,
            settings: input.settings,
            capitalSettings: input.capitalSettings,
            strategyKeys: input.selectedStrategies.map((strategy) => strategy.key),
            exitStrategyKeys: (input.exitStrategyCandidates ?? []).map((strategy) => strategy.key),
            useRustEnginePreference: input.useRustEnginePreference === true,
            providerBySymbol,
            candidatePoolSize: input.candidatePoolSize,
            minFreshSupport: input.minFreshSupport,
            ...(input.foldEnd !== undefined ? { foldEnd: input.foldEnd } : {}),
            ...(input.researchProgram ? { researchProgram: input.researchProgram } : {}),
        };
    });
    const completed: Array<{ task: AssetOpportunityBatchWorkerTask; iteration: AssetOpportunityIterationResult }> = [];
    const sweep = await runAssetOpportunityBatchSweep({
        tasks,
        runnerCount: chunkCount,
        createRunner: input.batchTaskRunnerFactory,
        onIterationResult: async (task, iteration) => {
            completed.push({ task, iteration });
        },
        onProgress: (task, progress, aggregate) => {
            const chunkStart = (task.assetChunkIndex ?? 0) * chunkSize;
            callbacks.onProgress({
                percent: aggregate.percent,
                text: progress.status,
                status: progress.status,
                phase: progress.phase as AssetOpportunityIterationProgress["phase"],
                oosActive: false,
                assetIndex: chunkStart + progress.assetIndex,
                totalAssets,
                strategyIndex: progress.strategyIndex,
                loadedSymbols: Math.min(totalAssets, chunkStart + progress.loadedSymbols),
                failedSymbols: progress.failedSymbols,
            });
        },
        onRunLog: (event, payload) => input.runLog?.(event, payload),
        isCancelled,
    });
    if (sweep.fatal) throw new Error(sweep.fatal.error);
    if (completed.length === 0) {
        if (sweep.cancelled || isCancelled()) {
            return {
                results: [],
                cancelled: true,
                assetDiagnostics: {
                    totalAssets,
                    assetsWithFreshEntry: 0,
                    assetsWithNoFreshEntry: 0,
                    selectGradeAssets: 0,
                    watchGradeAssets: 0,
                    rejectGradeAssets: 0,
                    failedAssets: [],
                    work: {
                        selectedStrategies: input.selectedStrategies.length,
                        candidateEvaluationsEstimated: 0,
                        candidateEvaluationsAttempted: 0,
                        candidateEvaluationsCompleted: 0,
                        candidateEvaluationFailures: 0,
                        signalCacheHits: 0,
                        signalCacheMisses: 0,
                        freshEntryRechecks: 0,
                        oosEvaluations: 0,
                        winnerAnalyticsRecomputations: 0,
                        loadedBars: { min: 0, max: 0, avg: 0 },
                    },
                    timingsMs: {
                        total: 0,
                        dataLoading: 0,
                        dataPreparation: 0,
                        inSampleSearch: 0,
                        parameterGeneration: 0,
                        candidateBacktests: 0,
                        freshEntryRechecks: 0,
                        oosValidation: 0,
                        resultReduction: 0,
                        winnerAnalytics: 0,
                        yielding: 0,
                        other: 0,
                    },
                    timingSummary: {
                        wallClockMs: 0,
                        aggregateStrategyWorkMs: 0,
                        parallelism: 0,
                    },
                },
                totals: {
                    totalAssets,
                    assetsWithFreshEntry: 0,
                    selectGradeAssets: 0,
                    watchGradeAssets: 0,
                    rejectGradeAssets: 0,
                    failedAssets: 0,
                    engineUsage: {
                        rustRequested: input.useRustEnginePreference === true,
                        rustAttemptedRuns: 0,
                        rustCompletedRuns: 0,
                        rustFallbackRuns: 0,
                        typescriptCompletedRuns: 0,
                        typescriptReasons: [],
                    },
                },
                summary: "",
            };
        }
        throw new Error("Asset Opportunity worker sweep completed without a result.");
    }
    const merged = mergeAssetOpportunityChunkResults(completed, input.selectedStrategies);
    const accumulated: FinderAssetOpportunityResult[] = [];
    const assetIndexBySymbol = new Map(input.symbols.map((symbol, index) => [symbol, index]));
    for (const result of merged.results) {
        accumulated.push(result);
        callbacks.onAssetResult({
            result,
            assetIndex: assetIndexBySymbol.get(result.symbol) ?? -1,
            totalAssets,
            results: accumulated,
        });
    }
    return {
        ...merged,
        cancelled: sweep.cancelled,
    };
}

export async function processFinderAssetOpportunityRun(
    input: FinderAssetOpportunityRunInput & {
        /** Optional Rust-only asset chunking for the single-run route. */
        batchTaskRunnerFactory?: AssetOpportunityBatchRunnerFactory;
        assetWorkerCount?: number;
        providerBySymbol?: Record<string, string>;
    },
    writer: (event: FinderAssetOpportunityStreamEvent) => void,
    owner: number,
): Promise<void> {
    const { symbols, selectedStrategies } = input;
    const totalAssets = symbols.length;
    assertAssetOpportunityStrategySelection(selectedStrategies);

    // Initialize run state for the asset-opportunity kind so /status reattach
    // returns the correct terminal slice and totals.
    runState = {
        runId: input.runId,
        startedAt: Date.now(),
        finishedAt: null,
        interval: input.interval,
        jobKind: "asset_opportunity",
        ...(input.foldEnd !== undefined ? { foldEnd: input.foldEnd } : {}),
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        strategyIndex: 0,
        strategyCount: selectedStrategies.length,
        phase: "loading",
        totalSymbols: totalAssets,
        progressPercent: 0,
        statusText: "Starting...",
        loadedSymbols: 0,
        failedSymbols: 0,
        candidates: [],
        assetResults: [],
        diagnostics: null,
        cancelled: false,
        summary: null,
        error: null,
        totals: null,
        assetTotals: null,
        assetDiagnostics: null,
    };
    const snapshot = runState;

    const estimatedCandidateEvaluations = totalAssets * selectedStrategies.length * (
        Math.max(1, Math.floor(input.options.maxRuns)) + input.candidatePoolSize
    );
    debugLogger.event("finder.asset_opportunity.start", {
        runId: input.runId,
        interval: input.interval,
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        totalAssets,
        maxRuns: input.options.maxRuns,
        candidatePoolSize: input.candidatePoolSize,
        estimatedCandidateEvaluations,
    });

    writer({
        type: "asset_start",
        runId: input.runId,
        totalAssets,
        interval: input.interval,
        strategyKey: selectedStrategies[0]!.key,
        strategyName: selectedStrategies[0]!.name,
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        strategyNames: selectedStrategies.map((strategy) => strategy.name),
    });

    const throttleProgressWrite = createProgressEventThrottle();
    const callbacks = {
        onProgress: (progress: Parameters<NonNullable<AssetOpportunityIterationCallbacks["onProgress"]>>[0]) => {
            snapshot.phase = progress.phase;
            snapshot.progressPercent = progress.percent;
            snapshot.statusText = progress.status;
            snapshot.loadedSymbols = progress.loadedSymbols;
            snapshot.failedSymbols = progress.failedSymbols;
            snapshot.strategyIndex = progress.strategyIndex;
            throttleProgressWrite({
                percent: progress.percent,
                phase: progress.phase,
                write: () => {
                    writer({
                        type: "asset_progress",
                        percent: progress.percent,
                        text: progress.status,
                        status: progress.status,
                        phase: progress.phase,
                        assetIndex: progress.assetIndex,
                        totalAssets: progress.totalAssets,
                        oosActive: progress.oosActive,
                    });
                },
            });
        },
        onAssetResult: (asset: Parameters<NonNullable<AssetOpportunityIterationCallbacks["onAssetResult"]>>[0]) => {
            snapshot.assetResults = asset.results;
            writer({
                type: "asset_complete",
                asset: asset.result,
                assetIndex: asset.assetIndex,
                totalAssets: asset.totalAssets,
            });
        },
        onStatus: (status: string) => {
            snapshot.statusText = status;
        },
    } satisfies AssetOpportunityIterationCallbacks;
    const workerFactory = input.batchTaskRunnerFactory;
    const workerCount = input.assetWorkerCount ?? 1;
    const iteration = workerFactory && workerCount > 1
        ? await runFinderAssetOpportunityWorkerSweep(
            { ...input, batchTaskRunnerFactory: workerFactory, assetWorkerCount: workerCount },
            callbacks,
            () => runOwner !== owner || input.abortSignal.aborted,
        )
        : await runAssetOpportunityIteration(
            input,
            callbacks,
            () => runOwner !== owner || input.abortSignal.aborted,
        );

    snapshot.assetResults = iteration.results;
    snapshot.cancelled = iteration.cancelled;
    snapshot.phase = iteration.cancelled ? "cancelled" : "done";
    snapshot.finishedAt = Date.now();
    snapshot.assetTotals = iteration.totals;
    snapshot.assetDiagnostics = iteration.assetDiagnostics;
    snapshot.summary = iteration.summary;

    debugLogger.event(
        iteration.cancelled
            ? "finder.asset_opportunity.run.cancelled"
            : "finder.asset_opportunity.run.complete",
        {
            runId: input.runId,
            interval: input.interval,
            totalAssets,
            assetsWithFreshEntry: iteration.totals.assetsWithFreshEntry,
            assetsWithNoFreshEntry: iteration.assetDiagnostics.assetsWithNoFreshEntry,
            selectGradeAssets: iteration.totals.selectGradeAssets,
            watchGradeAssets: iteration.totals.watchGradeAssets,
            rejectGradeAssets: iteration.totals.rejectGradeAssets,
            failedAssets: iteration.totals.failedAssets,
            retainedResults: iteration.results.length,
            estimatedCandidateEvaluations,
            durationMs: Math.max(0, Date.now() - snapshot.startedAt),
        },
    );

    writer({
        type: "asset_done",
        ok: !iteration.cancelled,
        cancelled: iteration.cancelled,
        runId: input.runId,
        interval: input.interval,
        totals: iteration.totals,
        summary: iteration.summary,
        // Keep the full scalar run result set. The browser applies topN only
        // to the visible list so post-run re-sort can rank every opportunity.
        assets: iteration.results,
        diagnostics: null,
        assetDiagnostics: iteration.assetDiagnostics,
    });
}

type FreshWindowIdentity = {
    identity: Record<string, unknown>;
    judgmentStatus: FinderFreshWindowJudgmentStatus;
    judgmentInvalidReasons: string[];
};

type FinderAssetOpportunityBatchInput = FinderAssetOpportunityRunInput & {
    batch: { startHoldoutBars: number; endHoldoutBars: number };
    /** Optional worker factory; omitted callers use the sequential path. */
    batchTaskRunnerFactory?: AssetOpportunityBatchRunnerFactory;
    /** Normalized symbol-to-provider map for worker task payloads. */
    providerBySymbol?: Record<string, string>;
    foldSchedule?: FinderAssetOpportunityFoldScheduleEntry[];
    batchRole?: FinderFreshWindowBatchRole;
    dataSyncSnapshot?: string;
    gitCommit?: string;
    archiveSort?: FinderAssetOpportunityArchiveSort | null;
};

function sha256Json(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildFreshWindowIdentity(
    input: FinderAssetOpportunityBatchInput,
    selectedStrategies: FinderSelectedStrategy[],
): FreshWindowIdentity | null {
    if (input.researchProgram !== "fresh-window") return null;
    const symbols = [...input.symbols];
    const strategyKeys = selectedStrategies.map((strategy) => strategy.key);
    const providerBySymbol = Object.fromEntries(
        symbols.map((symbol) => [
            symbol,
            input.providerBySymbol?.[symbol.trim().toUpperCase()] ?? "binance",
        ]),
    );
    const evalLastBars = input.options.assetOpportunity?.evalLastBars ?? null;
    const oosIgnoreLastBars = input.options.assetOpportunity?.oosIgnoreLastBars ?? null;
    const oosHorizons = input.options.assetOpportunity?.oosHorizons ?? [];
    const dataSyncSnapshot = input.dataSyncSnapshot ?? "unknown";
    const gitCommit = input.gitCommit ?? "unknown";
    const identity: Record<string, unknown> = {
        identityVersion: 1,
        researchProgram: input.researchProgram,
        batchRole: input.batchRole ?? null,
        interval: input.interval,
        symbols,
        symbolDigest: sha256Json(symbols),
        strategyKeys,
        strategyDigest: sha256Json(strategyKeys),
        providerBySymbol,
        engine: {
            requested: input.useRustEnginePreference === true ? "rust" : "typescript",
            effective: "typescript",
            rustEquivalent: false,
        },
        foldSchedule: input.foldSchedule ?? null,
        foldScheduleDigest: sha256Json(input.foldSchedule ?? null),
        controlSeed: 42,
        dataSyncSnapshot,
        gitCommit,
        evalLastBars,
        oosIgnoreLastBars,
        oosHorizons,
    };
    const invalidReasons: string[] = [];
    invalidReasons.push(...validateFreshWindowExecutionSettings(input.settings));
    if (!input.foldSchedule || input.foldSchedule.length !== FINDER_ASSET_FRESH_FOLD_COUNT) {
        invalidReasons.push(`foldSchedule must contain exactly ${FINDER_ASSET_FRESH_FOLD_COUNT} entries`);
    }
    if (dataSyncSnapshot === "unknown") invalidReasons.push("dataSyncSnapshot is missing");
    if (gitCommit === "unknown") invalidReasons.push("gitCommit is missing");
    if (!isFinderFreshWindowBatchRole(input.batchRole)) invalidReasons.push("batchRole is missing or invalid");
    if (evalLastBars !== 1000) invalidReasons.push(`evalLastBars must be 1000 (got ${String(evalLastBars)})`);
    if (oosIgnoreLastBars !== 26) invalidReasons.push(`oosIgnoreLastBars must be 26 (got ${String(oosIgnoreLastBars)})`);
    if (oosHorizons.length !== 3 || oosHorizons.some((value, index) => value !== [12, 18, 24][index])) {
        invalidReasons.push(`oosHorizons must be [12,18,24] (got ${JSON.stringify(oosHorizons)})`);
    }
    identity.configIdentityDigest = sha256Json(identity);
    return {
        identity,
        judgmentStatus: invalidReasons.length === 0 ? "VALID" : "INVALID",
        judgmentInvalidReasons: invalidReasons,
    };
}

/**
 * Process one Asset Opportunity BATCH job: runs the validated holdout sweep
 * (ascending) under ONE owner/run id. Each iteration clones the options with
 * the current holdout value (keeping the same random seed so differences come
 * from the holdout boundary, not a new sample), archives the top-N payload to
 * `archive/asset opportunity/oos-holdout-<N>-bars.txt`, and reports the
 * iteration's full scalar rows on `asset_batch_iteration_done`. Only the
 * current iteration's rows are retained; the terminal view carries the LAST
 * completed iteration. An archive failure stops the batch with a visible
 * fatal; completed blocks stay intact. Stream disconnect does not cancel the
 * server job — Stop and reload reattach use the same owner/status machinery.
 */
export async function processFinderAssetOpportunityBatchRun(
    input: FinderAssetOpportunityBatchInput,
    writer: (event: FinderAssetOpportunityBatchStreamEvent) => void,
    owner: number,
    archiveRoot: string,
    archiveAppend?: AssetOpportunityArchiveAppend,
): Promise<void> {
    const { symbols, selectedStrategies, batch } = input;
    const totalAssets = symbols.length;
    const legacyHoldoutValues = buildAssetOpportunityBatchHoldoutValues(
        batch.startHoldoutBars,
        batch.endHoldoutBars,
    );
    const foldEntries: FinderAssetOpportunityFoldScheduleEntry[] = input.researchProgram === "fresh-window"
        ? input.foldSchedule ?? (() => {
            throw new Error("Fresh-window batch requires an explicit foldSchedule.");
        })()
        : legacyHoldoutValues.map((holdoutBars) => ({
            holdoutBars,
            foldEnd: input.foldEnd ?? 0,
        }));
    if (input.researchProgram === "fresh-window" && foldEntries.length !== FINDER_ASSET_FRESH_FOLD_COUNT) {
        throw new Error(`Fresh-window batch requires exactly ${FINDER_ASSET_FRESH_FOLD_COUNT} fold schedule entries.`);
    }
    if (input.researchProgram === "fresh-window"
        && (!input.dataSyncSnapshot || input.dataSyncSnapshot === "unknown"
            || !input.gitCommit || input.gitCommit === "unknown")) {
        throw new Error("Fresh-window batch requires real dataSyncSnapshot and gitCommit provenance.");
    }
    if (input.researchProgram === "fresh-window" && !isFinderFreshWindowBatchRole(input.batchRole)) {
        throw new Error("Fresh-window batch requires a valid batchRole: collection, judged, or replication.");
    }
    const holdoutValues = foldEntries.map((entry) => entry.holdoutBars);
    const totalIterations = holdoutValues.length;
    assertAssetOpportunityStrategySelection(selectedStrategies);
    const freshWindowIdentity = buildFreshWindowIdentity(input, selectedStrategies);

    runState = {
        runId: input.runId,
        startedAt: Date.now(),
        finishedAt: null,
        interval: input.interval,
        jobKind: "asset_opportunity_batch",
        ...(input.researchProgram ? { researchProgram: input.researchProgram } : {}),
        ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
        ...(freshWindowIdentity && freshWindowIdentity.judgmentInvalidReasons.length > 0
            ? { judgmentInvalidReasons: freshWindowIdentity.judgmentInvalidReasons }
            : {}),
        ...(input.foldEnd !== undefined ? { foldEnd: input.foldEnd } : {}),
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        strategyIndex: 0,
        strategyCount: selectedStrategies.length,
        phase: "loading",
        totalSymbols: totalAssets,
        progressPercent: 0,
        statusText: "Starting...",
        loadedSymbols: 0,
        failedSymbols: 0,
        candidates: [],
        assetResults: [],
        diagnostics: null,
        cancelled: false,
        summary: null,
        error: null,
        totals: null,
        assetTotals: null,
        assetDiagnostics: null,
        batch: {
            startHoldoutBars: batch.startHoldoutBars,
            endHoldoutBars: batch.endHoldoutBars,
            currentHoldoutBars: null,
            currentIteration: 0,
            totalIterations,
            completedIterations: 0,
            failedIterations: 0,
        },
    };
    const snapshot = runState;

    debugLogger.event("finder.asset_opportunity_batch.start", {
        runId: input.runId,
        interval: input.interval,
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        totalAssets,
        startHoldoutBars: batch.startHoldoutBars,
        endHoldoutBars: batch.endHoldoutBars,
        totalIterations,
        archiveSort: ASSET_OPPORTUNITY_ALL_SORTS,
    });

    writer({
        type: "asset_batch_start",
        runId: input.runId,
        startHoldoutBars: batch.startHoldoutBars,
        endHoldoutBars: batch.endHoldoutBars,
        totalIterations,
        totalAssets,
        strategyKeys: selectedStrategies.map((strategy) => strategy.key),
        strategyNames: selectedStrategies.map((strategy) => strategy.name),
        archiveSort: ASSET_OPPORTUNITY_ALL_SORTS,
    });

    // Append the run's full configuration to the archive config log BEFORE the
    // sweep so every archived holdout file has a matching, timestamped config
    // record even when the operator forgets Copy Configuration (and even when
    // the run dies mid-sweep). Trade-filter bounds are normalized to null when
    // the toggle is off so the record can never read as an enforced filter.
    // Best-effort: a metadata write must not kill a research run — holdout
    // archive failures stay fatal, this one only warns.
    try {
        await appendAssetOpportunityArchiveRunConfig({
            root: archiveRoot,
            ...(input.researchProgram ? { program: input.researchProgram } : {}),
            batchRunId: input.runId,
            config: {
                runId: input.runId,
                interval: input.interval,
                strategyKeys: selectedStrategies.map((strategy) => strategy.key),
                batch: { startHoldoutBars: batch.startHoldoutBars, endHoldoutBars: batch.endHoldoutBars },
                ...(input.foldSchedule ? { foldSchedule: input.foldSchedule } : {}),
                ...(input.researchProgram ? { researchProgram: input.researchProgram } : {}),
                finder: {
                    ...input.options,
                    ...captureTradeFilter(input.options),
                },
                backtestSettings: input.settings,
                capitalSettings: input.capitalSettings,
                ...(freshWindowIdentity ? { freshWindowIdentity: freshWindowIdentity.identity } : {}),
                ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
                ...(input.foldEnd !== undefined || input.researchProgram === "fresh-window" ? {
                    ...(input.foldEnd !== undefined ? { foldEnd: input.foldEnd } : {}),
                    dataSyncSnapshot: input.dataSyncSnapshot ?? "unknown",
                    gitCommit: input.gitCommit ?? "unknown",
                } : {}),
            },
            ...(archiveAppend ? { append: archiveAppend } : {}),
            ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
            ...(freshWindowIdentity && freshWindowIdentity.judgmentInvalidReasons.length > 0
                ? { judgmentInvalidReasons: freshWindowIdentity.judgmentInvalidReasons }
                : {}),
        });
    } catch (error) {
        if (input.researchProgram === "fresh-window") {
            throw new Error(
                `Fresh-window configuration archive failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        debugLogger.warn("finder.asset_opportunity_batch.config_archive_failed", {
            runId: input.runId,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const isCancelled = () => runOwner !== owner || input.abortSignal.aborted;
    const lastIteration: {
        results: FinderAssetOpportunityResult[];
        assetDiagnostics: FinderAssetOpportunityDiagnostics | null;
        totals: FinderAssetOpportunityTotals | null;
        holdoutBars: number | null;
    } = { results: [], assetDiagnostics: null, totals: null, holdoutBars: null };
    const summaryRowsByTaskIndex = new Map<number, FinderAssetOpportunityCandidateSummaryRow[]>();
    const summaryRowsOverflowByTaskIndex = new Set<number>();

    // Clone options for the current N; keep the same random seed so the only
    // difference between iterations is the holdout boundary.
    const buildIterationOptions = (holdoutBars: number): FinderOptions => ({
        ...input.options,
        assetOpportunity: {
            symbols: input.options.assetOpportunity?.symbols ?? [],
            candidatePoolSize: input.candidatePoolSize,
            minFreshSupport: input.minFreshSupport,
            oosHorizons: input.options.assetOpportunity?.oosHorizons,
            oosIgnoreLastBars: holdoutBars,
            evalLastBars: input.options.assetOpportunity?.evalLastBars,
        },
    });

    const failIteration = (holdoutBars: number, message: string): void => {
        snapshot.batch = {
            ...snapshot.batch!,
            failedIterations: snapshot.batch!.failedIterations + 1,
        };
        snapshot.phase = "fatal";
        snapshot.finishedAt = Date.now();
        snapshot.statusText = `Asset Opportunity batch failed at holdout ${holdoutBars}: ${message}`;
        snapshot.summary = snapshot.statusText;
        snapshot.error = message;
        debugLogger.warn("finder.asset_opportunity_batch.iteration_failed", {
            runId: input.runId,
            holdoutBars,
            error: message,
        });
        writer({
            type: "asset_batch_fatal",
            runId: input.runId,
            error: message,
            holdoutBars,
            completedIterations: snapshot.batch.completedIterations,
        });
    };

    // Sentinel thrown after the archive-fatal event was emitted, so the
    // parallel sweep stops without the caller double-reporting the fatal.
    class BatchArchiveFatalSentinel extends Error {}

    // Archive + retain + emit one COMPLETED iteration. Shared verbatim by the
    // sequential loop and the parallel sweep's ordered emission so both paths
    // have identical archive/event semantics. Archive writes stay strictly
    // ascending because both paths await this before the next iteration.
    const completeOrderedIteration = async (
        iterationIndex: number,
        holdoutBars: number,
        iteration: AssetOpportunityIterationResult,
        summaryRows: FinderAssetOpportunityCandidateSummaryRow[] = [],
        summaryRowsOverflow = false,
    ): Promise<void> => {
        snapshot.batch = {
            ...snapshot.batch!,
            currentHoldoutBars: holdoutBars,
            currentIteration: iterationIndex + 1,
        };
        // Archive compact performance-only top-N rows using the metric captured
        // before the batch started. All Sorts emits one delimited block per
        // ranking into this same per-N file.
        let archiveFilename = "";
        // Pure function of the iteration's unchanged result set: compute once,
        // not once per sort metric.
        const baseline = buildAssetOpportunityForwardOosBaseline(iteration.results);
        const fullPoolContext = input.researchProgram === "fresh-window"
            ? buildFinderAssetOpportunityPairContext(summaryRows, selectedStrategies.length)
            : undefined;
        try {
            if (summaryRowsOverflow) {
                throw new Error(
                    `Fresh-window summary rows exceeded the per-task cap of ${FRESH_WINDOW_SUMMARY_ROWS_PER_TASK_CAP}.`,
                );
            }
            if (input.researchProgram === "fresh-window") {
                const controlTrace = buildFinderAssetOpportunityControlTrace(summaryRows, iterationIndex, 12, 42);
                await appendAssetOpportunityArchiveFoldIdentities({
                    root: archiveRoot,
                    program: input.researchProgram,
                    batchRunId: input.runId,
                    batchRole: input.batchRole,
                    holdoutBars,
                    rows: summaryRows,
                    expectedRowCount: iteration.expectedCandidateSummaryRows,
                    outcomeRowCount: summaryRows.filter((row) => row.forwardOutcomes?.["12"] !== undefined).length,
                    controlSeed: controlTrace.seed,
                    controlDrawIdentities: controlTrace.draws,
                    controlDrawDigest: controlTrace.digest,
                    ...(iteration.foldMetadata ? { foldMetadata: iteration.foldMetadata } : {}),
                    ...(input.dataSyncSnapshot ? { dataSyncSnapshot: input.dataSyncSnapshot } : {}),
                    ...(input.gitCommit ? { gitCommit: input.gitCommit } : {}),
                    ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
                    ...(freshWindowIdentity && freshWindowIdentity.judgmentInvalidReasons.length > 0
                        ? { judgmentInvalidReasons: freshWindowIdentity.judgmentInvalidReasons }
                        : {}),
                    ...(archiveAppend ? { append: archiveAppend } : {}),
                });
            }
            const pairSummaries = buildAssetOpportunityPairSummaries(iteration.results);
            await appendAssetOpportunityArchivePairSummary({
                root: archiveRoot,
                ...(input.researchProgram ? { program: input.researchProgram } : {}),
                batchRunId: input.runId,
                holdoutBars,
                pairSummaries,
                ...(fullPoolContext ? { fullPoolContext } : {}),
                ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
                ...(freshWindowIdentity && freshWindowIdentity.judgmentInvalidReasons.length > 0
                    ? { judgmentInvalidReasons: freshWindowIdentity.judgmentInvalidReasons }
                    : {}),
                ...(archiveAppend ? { append: archiveAppend } : {}),
            });
            for (const sortMetric of resolveAssetOpportunityArchiveSorts()) {
                const archiveResults = sortAssetOpportunityResultsByMetric(iteration.results, sortMetric);
                const topResults = archiveResults
                    .slice(0, Math.max(1, input.options.topN))
                    .map((result, index) => buildAssetOpportunityPerformancePayload({
                        result,
                        rank: index + 1,
                    }));
                const appended = await appendAssetOpportunityArchiveBlock({
                    root: archiveRoot,
                    ...(input.researchProgram ? { program: input.researchProgram } : {}),
                    batchRunId: input.runId,
                    holdoutBars,
                    sortMetric,
                    topResults,
                    baseline,
                    ...(iteration.foldMetadata ? { foldMetadata: iteration.foldMetadata } : {}),
                    ...(input.dataSyncSnapshot ? { dataSyncSnapshot: input.dataSyncSnapshot } : {}),
                    ...(input.gitCommit ? { gitCommit: input.gitCommit } : {}),
                    ...(freshWindowIdentity ? { judgmentStatus: freshWindowIdentity.judgmentStatus } : {}),
                    ...(freshWindowIdentity && freshWindowIdentity.judgmentInvalidReasons.length > 0
                        ? { judgmentInvalidReasons: freshWindowIdentity.judgmentInvalidReasons }
                        : {}),
                    ...(archiveAppend ? { append: archiveAppend } : {}),
                });
                archiveFilename = path.basename(appended.path);
                debugLogger.event("finder.asset_opportunity_batch.iteration.complete", {
                    runId: input.runId,
                    holdoutBars,
                    iterationIndex,
                    totalIterations,
                    archiveFilename,
                    sortMetric: sortMetric ?? "run_default",
                    bytes: appended.bytes,
                    assets: iteration.results.length,
                    durationMs: Math.max(0, Date.now() - snapshot.startedAt),
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            snapshot.batch = {
                ...snapshot.batch!,
                failedIterations: snapshot.batch!.failedIterations + 1,
            };
            snapshot.phase = "fatal";
            snapshot.finishedAt = Date.now();
            snapshot.statusText = `Asset Opportunity batch archive failed at holdout ${holdoutBars}: ${message}`;
            snapshot.summary = snapshot.statusText;
            snapshot.error = message;
            debugLogger.warn("finder.asset_opportunity_batch.archive_failed", {
                runId: input.runId,
                holdoutBars,
                error: message,
            });
            writer({
                type: "asset_batch_fatal",
                runId: input.runId,
                error: `Archive write failed for holdout ${holdoutBars}: ${message}`,
                holdoutBars,
                completedIterations: snapshot.batch.completedIterations,
            });
            throw new BatchArchiveFatalSentinel(message);
        }

        // Retain ONLY a successfully archived iteration for re-sort + terminal
        // view. A failed archive must not expose rows that have no durable
        // archive block.
        snapshot.assetResults = iteration.results;
        lastIteration.results = iteration.results;
        lastIteration.assetDiagnostics = iteration.assetDiagnostics;
        lastIteration.totals = iteration.totals;
        lastIteration.holdoutBars = holdoutBars;

        snapshot.batch = {
            ...snapshot.batch!,
            completedIterations: snapshot.batch!.completedIterations + 1,
        };

        writer({
            type: "asset_batch_iteration_done",
            runId: input.runId,
            holdoutBars,
            iterationIndex,
            totalIterations,
            assets: iteration.results,
            totals: iteration.totals,
            diagnostics: null,
            assetDiagnostics: iteration.assetDiagnostics,
            archiveFilename,
        });
    };

    // Parallel sweep when a runner factory is wired (production HTTP path).
    // Small holdout ranges are decomposed into contiguous asset chunks so a
    // two-holdout run can still occupy the bounded worker pool instead of
    // leaving most CPU idle. Larger ranges keep one whole iteration per task,
    // preserving cross-holdout dataset-cache reuse.
    const canChunkAssets = input.batchTaskRunnerFactory && totalAssets >= ASSET_OPPORTUNITY_BATCH_MIN_CHUNKED_ASSETS;
    // The request may carry the UI's Rust preference even when the current
    // settings force every candidate through TypeScript. Only apply the Rust
    // worker cap when a Rust execution is actually possible; otherwise the
    // smaller chunks can evict the holdout signal cache before reuse.
    const resolvedCapitalSettings = resolveCapitalSettingsFromRaw(
        input.capitalSettings as unknown as Record<string, unknown>,
    );
    const rustCanRun = input.useRustEnginePreference === true
        && !requiresTypescriptEngine(input.settings)
        && isRustSupportedTradeSizingMode(resolvedCapitalSettings.sizingMode);
    const workerCapacity = input.batchTaskRunnerFactory
        ? canChunkAssets
            ? resolveAssetOpportunityChunkWorkerCount(
                totalIterations,
                totalAssets,
                process.env,
                totalmem(),
                rustCanRun,
            )
            : resolveAssetOpportunityBatchWorkerCount(
                Math.max(totalIterations, ASSET_OPPORTUNITY_BATCH_PARALLEL_TASK_TARGET),
                totalAssets,
                process.env,
                totalmem(),
                { rustEngine: rustCanRun },
            )
        : 1;
    const assetChunkCount = canChunkAssets
        ? Math.max(1, Math.min(totalAssets, workerCapacity))
        : 1;
    const totalWorkerTasks = totalIterations * assetChunkCount;
    let lastBatchProgressPercent = 0;
    const resolveMonotonicBatchProgress = (percent: number): number => {
        const normalized = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
        lastBatchProgressPercent = Math.max(lastBatchProgressPercent, normalized);
        return lastBatchProgressPercent;
    };
    const workerCount = input.batchTaskRunnerFactory
        ? assetChunkCount > 1
            ? assetChunkCount
            : resolveAssetOpportunityBatchWorkerCount(
                totalIterations,
                totalAssets,
                process.env,
                totalmem(),
                {
                    // Match the actual engine eligibility used for chunking;
                    // a Rust preference alone is not sufficient to serialize
                    // this TypeScript-only workload.
                    rustEngine: rustCanRun,
                    taskCount: totalWorkerTasks,
                },
            )
        : 1;

    if (input.batchTaskRunnerFactory && workerCount > 1) {
        debugLogger.event("finder.asset_opportunity_batch.parallel_start", {
            runId: input.runId,
            workerCount,
            totalIterations,
            totalAssets,
            assetChunkCount,
        });
        // Worker task payloads carry a plain provider map (functions cannot
        // cross the worker boundary); keys normalized like resolveServerProvider.
        const providerRecord: Record<string, string> | null = input.providerBySymbol
            ? Object.fromEntries(
                Object.entries(input.providerBySymbol)
                    .map(([symbol, provider]) => [symbol.trim().toUpperCase(), provider]),
            )
            : null;
        const tasks: AssetOpportunityBatchWorkerTask[] = holdoutValues.flatMap((holdoutBars, iterationIndex) => {
            const foldEntry = foldEntries[iterationIndex]!;
            const chunkSize = Math.ceil(totalAssets / assetChunkCount);
            return Array.from({ length: assetChunkCount }, (_, assetChunkIndex) => {
                const start = assetChunkIndex * chunkSize;
                const end = Math.min(totalAssets, start + chunkSize);
                return {
                    taskIndex: iterationIndex * assetChunkCount + assetChunkIndex,
                    holdoutBars,
                    ...(assetChunkCount > 1
                        ? { assetChunkIndex, assetChunkCount, includeFullStrategyBreakdown: true }
                        : {}),
                    runId: input.runId,
                    interval: input.interval,
                    symbols: symbols.slice(start, end),
                    options: buildIterationOptions(holdoutBars),
                    settings: input.settings,
                    capitalSettings: input.capitalSettings,
                    strategyKeys: selectedStrategies.map((strategy) => strategy.key),
                    exitStrategyKeys: (input.exitStrategyCandidates ?? []).map((strategy) => strategy.key),
                    useRustEnginePreference: input.useRustEnginePreference === true,
                    providerBySymbol: providerRecord,
                    candidatePoolSize: input.candidatePoolSize,
                    minFreshSupport: input.minFreshSupport,
                    ...(input.researchProgram === "fresh-window"
                        ? { foldEnd: foldEntry.foldEnd, loadDatasetIsRaw: true }
                        : input.foldEnd !== undefined
                            ? { foldEnd: input.foldEnd }
                            : {}),
                    ...(input.researchProgram ? { researchProgram: input.researchProgram } : {}),
                };
            });
        });
        let sweep: AssetOpportunityBatchSweepResult;
        // ONE throttle for the whole sweep: progress messages from every
        // in-flight worker interleave, and the aggregate percent is what the
        // browser renders.
        const throttleProgressWrite = createProgressEventThrottle();
        try {
            const chunkResultsByIteration = new Map<number, Array<{
                task: AssetOpportunityBatchWorkerTask;
                iteration: AssetOpportunityIterationResult;
            }>>();
            sweep = await runAssetOpportunityBatchSweep({
                tasks,
                runnerCount: workerCount,
                createRunner: input.batchTaskRunnerFactory,
                onIterationResult: async (task, iteration) => {
                    const iterationIndex = Math.floor(task.taskIndex / assetChunkCount);
                    if (assetChunkCount === 1) {
                        const summaryRows = summaryRowsByTaskIndex.get(task.taskIndex) ?? [];
                        summaryRowsByTaskIndex.delete(task.taskIndex);
                        const summaryRowsOverflow = summaryRowsOverflowByTaskIndex.delete(task.taskIndex);
                        await completeOrderedIteration(iterationIndex, task.holdoutBars, iteration, summaryRows, summaryRowsOverflow);
                        return;
                    }
                    const entries = chunkResultsByIteration.get(iterationIndex) ?? [];
                    entries.push({ task, iteration });
                    chunkResultsByIteration.set(iterationIndex, entries);
                    if (entries.length < assetChunkCount) return;
                    chunkResultsByIteration.delete(iterationIndex);
                    let summaryRowsOverflow = false;
                    const summaryRows = [...entries]
                        .sort((left, right) => (left.task.assetChunkIndex ?? 0) - (right.task.assetChunkIndex ?? 0))
                        .flatMap(({ task: chunkTask }) => {
                            const rows = summaryRowsByTaskIndex.get(chunkTask.taskIndex) ?? [];
                            summaryRowsByTaskIndex.delete(chunkTask.taskIndex);
                            summaryRowsOverflow = summaryRowsOverflow
                                || summaryRowsOverflowByTaskIndex.delete(chunkTask.taskIndex);
                            return rows;
                        });
                    await completeOrderedIteration(
                        iterationIndex,
                        task.holdoutBars,
                        mergeAssetOpportunityChunkResults(entries, selectedStrategies),
                        summaryRows,
                        summaryRowsOverflow,
                    );
                },
                onProgress: (task, progress, aggregateState) => {
                    snapshot.phase = progress.phase as FinderJobPhase;
                    snapshot.statusText = `Batch OOS holdout ${task.holdoutBars} bars: ${progress.status}`;
                    snapshot.progressPercent = resolveMonotonicBatchProgress(aggregateState.percent);
                    // Latest-writer-wins across the in-flight iterations so
                    // /status keeps reporting live loaded/failed counters and
                    // the strategy index instead of zeros (each arriving
                    // event carries its own iteration's counters).
                    snapshot.loadedSymbols = progress.loadedSymbols;
                    snapshot.failedSymbols = progress.failedSymbols;
                    snapshot.strategyIndex = progress.strategyIndex;
                    snapshot.batch = {
                        ...snapshot.batch!,
                        currentHoldoutBars: aggregateState.inFlightHoldoutBars[0]
                            ?? snapshot.batch!.currentHoldoutBars,
                        currentIteration: Math.floor(task.taskIndex / assetChunkCount) + 1,
                    };
                    throttleProgressWrite({
                        percent: snapshot.progressPercent,
                        phase: progress.phase as string,
                        write: () => {
                            writer({
                                type: "asset_batch_progress",
                                runId: input.runId,
                                holdoutBars: task.holdoutBars,
                                iterationIndex: Math.floor(task.taskIndex / assetChunkCount),
                                totalIterations,
                                percent: snapshot.progressPercent,
                                phase: progress.phase as FinderJobPhase,
                                statusText: snapshot.statusText,
                                assetProgress: progress.percent,
                            });
                        },
                    });
                },
                onRunLog: (event, payload) => {
                    input.runLog?.(event, payload);
                },
                onCandidateSummaryChunk: input.researchProgram === "fresh-window"
                    ? (task, rows) => {
                        const existing = summaryRowsByTaskIndex.get(task.taskIndex) ?? [];
                        if (!appendFreshWindowSummaryRowsWithinCap(existing, rows)) {
                            summaryRowsOverflowByTaskIndex.add(task.taskIndex);
                        }
                        summaryRowsByTaskIndex.set(task.taskIndex, existing);
                    }
                    : undefined,
                isCancelled,
            });
        } catch (error) {
            // The archive-fatal path already emitted its terminal event.
            if (error instanceof BatchArchiveFatalSentinel) {
                return;
            }
            throw error;
        }
        if (sweep.fatal) {
            failIteration(sweep.fatal.task.holdoutBars, sweep.fatal.error);
            return;
        }
        if (sweep.cancelled) {
            snapshot.cancelled = true;
        }
    } else {
        // The holdout boundary changes the evaluation window, not the source
        // candles. Keep the large synthetic-leg/pair caches alive across all batch
        // iterations and reset only per-iteration diagnostics in the iteration
        // runner above. symbolCount attaches the plain-dataset LRU so each
        // symbol loads once for the whole sequential sweep.
        const assetLoadContext = createServerFinderAssetOpportunityLoadContext(totalAssets);
        const rustBatchDatasetCache = new Map<string, Promise<string | null>>();
        const paramSetCache = new Map<string, StrategyParams[]>();
        const throttleProgressWrite = createProgressEventThrottle();

        for (let iterationIndex = 0; iterationIndex < totalIterations; iterationIndex += 1) {
            if (isCancelled()) break;
            const holdoutBars = holdoutValues[iterationIndex]!;
            const foldEntry = foldEntries[iterationIndex]!;
            snapshot.batch = {
                ...snapshot.batch!,
                currentHoldoutBars: holdoutBars,
                currentIteration: iterationIndex + 1,
            };
            snapshot.phase = "loading";
            snapshot.statusText = `Batch OOS holdout ${holdoutBars} bars (iteration ${iterationIndex + 1}/${totalIterations})...`;
            snapshot.progressPercent = resolveMonotonicBatchProgress(
                (iterationIndex / totalIterations) * 100,
            );
            writer({
                type: "asset_batch_progress",
                runId: input.runId,
                holdoutBars,
                iterationIndex,
                totalIterations,
                percent: snapshot.progressPercent,
                phase: "loading",
                statusText: snapshot.statusText,
                assetProgress: 0,
            });

            let iteration: AssetOpportunityIterationResult;
            const summaryRows: FinderAssetOpportunityCandidateSummaryRow[] = [];
            let summaryRowsOverflow = false;
            try {
                iteration = await runAssetOpportunityIteration(
                    {
                        ...input,
                        options: buildIterationOptions(holdoutBars),
                        ...(input.researchProgram === "fresh-window"
                            ? { foldEnd: foldEntry.foldEnd, loadDatasetIsRaw: true }
                            : {}),
                        assetLoadContext,
                        rustBatchDatasetCache,
                        paramSetCache,
                    },
                    {
                        onProgress: (progress) => {
                            snapshot.phase = progress.phase;
                            snapshot.statusText = progress.status;
                            snapshot.loadedSymbols = progress.loadedSymbols;
                            snapshot.failedSymbols = progress.failedSymbols;
                            snapshot.strategyIndex = progress.strategyIndex;
                            snapshot.progressPercent = resolveMonotonicBatchProgress(
                                ((iterationIndex + progress.percent / 100) / totalIterations) * 100,
                            );
                            throttleProgressWrite({
                                percent: snapshot.progressPercent,
                                phase: progress.phase,
                                write: () => {
                                    writer({
                                        type: "asset_batch_progress",
                                        runId: input.runId,
                                        holdoutBars,
                                        iterationIndex,
                                        totalIterations,
                                        percent: snapshot.progressPercent,
                                        phase: progress.phase,
                                        statusText: progress.status,
                                        assetProgress: progress.percent,
                                    });
                                },
                            });
                        },
                        onAssetResult: () => {
                            // The iteration accumulates the full scalar set
                            // internally; batch renders only the iteration_done
                            // rows, so per-asset callbacks are ignored.
                        },
                        onStatus: (status) => {
                            snapshot.statusText = status;
                        },
                        onCandidateSummaryChunk: input.researchProgram === "fresh-window"
                            ? (rows) => {
                                if (!appendFreshWindowSummaryRowsWithinCap(summaryRows, rows)) summaryRowsOverflow = true;
                            }
                            : undefined,
                    },
                    isCancelled,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                failIteration(holdoutBars, message);
                return;
            }

            if (iteration.cancelled) {
                snapshot.cancelled = true;
                break;
            }

            try {
                await completeOrderedIteration(iterationIndex, holdoutBars, iteration, summaryRows, summaryRowsOverflow);
            } catch (error) {
                if (error instanceof BatchArchiveFatalSentinel) {
                    return;
                }
                throw error;
            }
        }
    }

    // Terminal: last completed iteration's rows + bounded batch counts.
    snapshot.cancelled = snapshot.cancelled || isCancelled();
    snapshot.phase = snapshot.cancelled ? "cancelled" : "done";
    snapshot.finishedAt = Date.now();
    snapshot.assetResults = lastIteration.results;
    snapshot.assetTotals = lastIteration.totals;
    snapshot.assetDiagnostics = lastIteration.assetDiagnostics;
    const completedIterations = snapshot.batch!.completedIterations;
    const failedIterations = snapshot.batch!.failedIterations;
    snapshot.summary = snapshot.cancelled
        ? `Asset Opportunity batch cancelled — ${completedIterations}/${totalIterations} holdout values completed (${failedIterations} failed).`
        : `Asset Opportunity batch complete — ${completedIterations}/${totalIterations} holdout values appended (${failedIterations} failed).`;

    debugLogger.event(
        snapshot.cancelled
            ? "finder.asset_opportunity_batch.cancelled"
            : "finder.asset_opportunity_batch.complete",
        {
            runId: input.runId,
            startHoldoutBars: batch.startHoldoutBars,
            endHoldoutBars: batch.endHoldoutBars,
            totalIterations,
            completedIterations,
            failedIterations,
            lastHoldout: lastIteration.holdoutBars,
            retainedResults: lastIteration.results.length,
            durationMs: Math.max(0, Date.now() - snapshot.startedAt),
        },
    );

    writer({
        type: "asset_batch_done",
        ok: !snapshot.cancelled,
        cancelled: snapshot.cancelled,
        runId: input.runId,
        completedIterations,
        failedIterations,
        assets: lastIteration.results,
        holdoutBars: lastIteration.holdoutBars,
        totals: lastIteration.totals,
        diagnostics: null,
        assetDiagnostics: lastIteration.assetDiagnostics,
        summary: snapshot.summary,
    });
}

/**
 * Validation shared by the Asset Opportunity single and batch routes.
 *
 * Everything that can reject a request WITHOUT starting heavy work lives here
 * (ownership, run id, pending Stop, symbol cap, heap guard, scope + mode,
 * option normalization, strategy resolution, provider map, and the second
 * pending-Stop check at the ownership boundary). The batch route then adds its
 * holdout-range validation and archive-sort normalization BEFORE acquiring
 * ownership, so a malformed range can never start heavy work.
 */
async function prepareAssetOpportunityRunPayload(
    body: FinderAssetOpportunityRequestBody & { batch?: unknown },
    batch?: { validate: true },
): Promise<{
    runId: string;
    symbols: string[];
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
    useRustEnginePreference: boolean;
    providerBySymbol: Map<string, string>;
    candidatePoolSize: number;
    minFreshSupport: number;
    /** Present only for the batch route: validated holdout range. */
    batchRange?: { start: number; end: number };
    /** Present only for the batch route: normalized archive sort selection. */
    archiveSort?: FinderAssetOpportunityArchiveSort | null;
    /** Present when the request selects the fresh-window archive namespace. */
    researchProgram?: AssetOpportunityResearchProgram;
    /** Present for fresh-window batches: the pre-registered budget role. */
    batchRole?: FinderFreshWindowBatchRole;
    /** Present when the request declares a point-in-time fold boundary. */
    foldEnd?: number;
    /** Present for fresh-window batch requests: one explicit entry per fold. */
    foldSchedule?: FinderAssetOpportunityFoldScheduleEntry[];
}> {
    const researchProgram = parseAssetOpportunityResearchProgram(body.researchProgram);
    const batchRole = researchProgram === "fresh-window"
        ? parseAssetOpportunityFreshWindowBatchRole(body.batchRole)
        : undefined;
    const foldEnd = parseAssetOpportunityFoldEnd(body.foldEnd);
    const foldSchedule = researchProgram === "fresh-window"
        ? parseAssetOpportunityFreshFoldSchedule(body.foldSchedule)
        : undefined;
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A Finder run is already running. Use Stop first.");
    }

    const runId = parseRunId(body.runId);
    if (consumePendingStopForRun(runId)) {
        throw new HttpStatusError(409, "Finder run was stopped before it started.");
    }

    const symbols = normalizeSymbols(body.symbols);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    if (symbols.length > ASSET_OPPORTUNITY_MAX_SYMBOLS) {
        throw new HttpStatusError(
            400,
            `Asset Opportunity supports at most ${ASSET_OPPORTUNITY_MAX_SYMBOLS} symbols per run.`,
        );
    }
    // Same thresholds as Universe (the batch dataset LRU now also retains one
    // copy per symbol), but the message must name the actual job kind.
    const heapWarning = resolveFinderUniverseHeapWarning(symbols.length, undefined, "Asset Opportunity");
    if (heapWarning) {
        throw new HttpStatusError(507, heapWarning);
    }
    const interval = parseInterval(body.interval);
    const parsedOptions = parseOptions(body.options);
    if (parsedOptions.scope !== "asset_opportunity") {
        throw new HttpStatusError(400, "Asset Opportunity requires scope asset_opportunity.");
    }
    const options = {
        ...parsedOptions,
        scope: "asset_opportunity" as const,
        ...(parsedOptions.assetOpportunity
            ? {
                assetOpportunity: {
                    ...parsedOptions.assetOpportunity,
                    oosIgnoreLastBars: normalizeFinderAssetOosIgnoreLastBars(
                        parsedOptions.assetOpportunity.oosIgnoreLastBars,
                    ),
                    evalLastBars: normalizeFinderAssetEvalLastBars(
                        parsedOptions.assetOpportunity.evalLastBars,
                    ),
                    oosHorizons: normalizeFinderAssetOosHorizons(
                        parsedOptions.assetOpportunity.oosHorizons,
                    ),
                },
            }
            : {}),
    };
    if (options.mode !== "random") {
        throw new HttpStatusError(400, "Asset Opportunity requires random Finder mode.");
    }

    // Batch-only validation runs BEFORE strategy resolution so a malformed
    // range or archive sort surfaces its own 400 first (locked by the route
    // tests) and can never start heavy work.
    let batchRange: { start: number; end: number } | undefined;
    let archiveSort: FinderAssetOpportunityArchiveSort | null | undefined;
    if (batch) {
        const batchSource = body.batch && typeof body.batch === "object" && !Array.isArray(body.batch)
            ? body.batch as Record<string, unknown>
            : {};
        const range = normalizeFinderAssetOosBatchHoldoutRange(
            batchSource.startHoldoutBars,
            batchSource.endHoldoutBars,
        );
        if (range.error !== null) {
            throw new HttpStatusError(400, range.error);
        }
        if (researchProgram === "fresh-window"
            && (range.start !== FINDER_ASSET_FRESH_FOLD_STRIDE_BARS
                || range.end !== FINDER_ASSET_FRESH_FOLD_COUNT * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS)) {
            throw new HttpStatusError(
                400,
                `Fresh-window batch must use holdout range ${FINDER_ASSET_FRESH_FOLD_STRIDE_BARS}..${FINDER_ASSET_FRESH_FOLD_COUNT * FINDER_ASSET_FRESH_FOLD_STRIDE_BARS} at stride ${FINDER_ASSET_FRESH_FOLD_STRIDE_BARS}.`,
            );
        }
        if (researchProgram === "fresh-window" && !foldSchedule) {
            throw new HttpStatusError(400, "Fresh-window batch requires an explicit 25-entry foldSchedule.");
        }
        batchRange = { start: range.start, end: range.end };
        archiveSort = normalizeAssetOpportunityArchiveSort(body.archiveSort);
    }

    const strategyKeys = parseStrategyKeys(body.strategyKeys, body.strategyKey);
    const selectedStrategies = await resolveSelectedStrategies(strategyKeys);
    const settings = (body.settings ?? {}) as BacktestSettings;
    const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
    if (researchProgram === "fresh-window") {
        const executionErrors = validateFreshWindowExecutionSettings(settings);
        if (executionErrors.length > 0) {
            throw new HttpStatusError(400, `Fresh-window execution contract rejected: ${executionErrors.join("; ")}`);
        }
        if (!process.env.FINDER_DATA_SYNC_SNAPSHOT || process.env.FINDER_DATA_SYNC_SNAPSHOT === "unknown"
            || !process.env.GIT_COMMIT || process.env.GIT_COMMIT === "unknown") {
            throw new HttpStatusError(400, "Fresh-window requires real FINDER_DATA_SYNC_SNAPSHOT and GIT_COMMIT provenance.");
        }
    }
    const useRustEnginePreference = body.useRustEnginePreference === true;
    const candidatePoolSize = clampCandidatePoolSize(options.assetOpportunity?.candidatePoolSize);
    const minFreshSupport = clampMinFreshSupport(options.assetOpportunity?.minFreshSupport);

    const exitStrategyCandidates = await resolveExitStrategyCandidates(body.exitStrategyKeys);
    const providerBySymbol = parseProviderBySymbol(body.providerBySymbol);

    if (consumePendingStopForRun(runId)) {
        throw new HttpStatusError(409, "Finder run was stopped before it started.");
    }

    return {
        runId,
        symbols,
        interval,
        options,
        settings,
        capitalSettings,
        selectedStrategies,
        exitStrategyCandidates,
        useRustEnginePreference,
        providerBySymbol,
        candidatePoolSize,
        minFreshSupport,
        ...(researchProgram ? { researchProgram } : {}),
        ...(batchRole ? { batchRole } : {}),
        ...(foldEnd !== undefined ? { foldEnd } : {}),
        ...(foldSchedule ? { foldSchedule } : {}),
        ...(batch ? { batchRange, archiveSort } : {}),
    };
}

function parseAssetOpportunityResearchProgram(raw: unknown): AssetOpportunityResearchProgram | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (!isAssetOpportunityResearchProgram(raw)) {
        throw new HttpStatusError(400, "Invalid Asset Opportunity research program.");
    }
    return raw;
}

function parseAssetOpportunityFreshWindowBatchRole(raw: unknown): FinderFreshWindowBatchRole {
    if (!isFinderFreshWindowBatchRole(raw)) {
        throw new HttpStatusError(400, "Fresh-window batchRole must be collection, judged, or replication.");
    }
    return raw;
}

function parseAssetOpportunityFoldEnd(raw: unknown): number | undefined {
    try {
        return normalizeFinderAssetFoldEnd(raw);
    } catch (error) {
        throw new HttpStatusError(400, error instanceof Error ? error.message : String(error));
    }
}

function parseAssetOpportunityFreshFoldSchedule(
    raw: unknown,
): FinderAssetOpportunityFoldScheduleEntry[] | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    try {
        return normalizeFinderAssetFreshFoldSchedule(raw);
    } catch (error) {
        throw new HttpStatusError(400, error instanceof Error ? error.message : String(error));
    }
}

function createAssetOpportunityDatasetLoaders(
    input: Pick<FinderAssetOpportunityRunInput, "researchProgram" | "foldEnd">,
) {
    // Fresh-window iterations receive raw data and slice it inside the leaf;
    // legacy runs keep the existing handler-side slice behavior.
    const loadDatasetFullClosed = (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]> => loadServerFinderDataset(symbol, interval, signal, context).then((data) =>
        input.researchProgram === "fresh-window"
            ? data
            : input.foldEnd === undefined ? data : sliceFinderAssetDataAtFoldEnd(data, input.foldEnd));
    const loadForwardDataset = (
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]> => loadServerFinderDataset(symbol, interval, signal, context).then((data) =>
        input.researchProgram === "fresh-window"
            ? data
            : sliceFinderAssetDataStrictlyAfterFoldEnd(data, input.foldEnd));
    return { loadDatasetFullClosed, loadForwardDataset };
}

/**
 * Shared NDJSON stream lifecycle for every Finder route: begin the stream,
 * install the disconnect guard, run the job with a best-effort writer, end the
 * stream on success, emit a route-specific fatal event on failure, and release
 * run ownership + flush deferred dataset invalidation in `finally`. A
 * disconnected stream never cancels the server job (reload reattach can
 * recover it via `/status`); the wrapper only stops writing.
 */
async function withFinderRunStream<TEvent extends AnyFinderStreamEvent>(args: {
    res: ViteHttpResponse;
    runId: string;
    owner: number;
    abortController: AbortController;
    /** Debug event name for terminal failures (route-specific). */
    debugEvent?: string;
    buildFatal: (message: string) => TEvent;
    run: (safeWrite: (event: TEvent) => void) => Promise<void>;
}): Promise<void> {
    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    let streamWritable = true;
    try {
        stream = beginNdjsonStream(args.res);
        const responseWithEvents = args.res as ViteHttpResponse & {
            on?: (event: string, listener: () => void) => void;
        };
        if (typeof responseWithEvents.on === "function") {
            const markDisconnected = () => { streamWritable = false; };
            responseWithEvents.on("close", markDisconnected);
            responseWithEvents.on("error", markDisconnected);
        }
        const safeWrite = (event: TEvent): void => {
            if (!streamWritable) return;
            if (!writeStreamEventBestEffort(stream!, event, args.runId)) {
                streamWritable = false;
            }
        };
        await args.run(safeWrite);
        if (streamWritable) {
            try {
                stream.end();
            } catch {
                streamWritable = false;
            }
        }
    } catch (error) {
        if (!stream) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (args.debugEvent) {
            debugLogger.event(args.debugEvent, {
                runId: args.runId,
                error: message,
            });
        }
        try {
            if (!streamWritable) return;
            stream.end(args.buildFatal(message));
        } catch {
            /* best-effort */
        }
    } finally {
        if (runOwner === args.owner) {
            // The owning run released (terminal or stopped while still
            // owning): flush a deferred invalidation now that no newer owner
            // exists whose datasets could be clobbered.
            flushPendingDatasetCacheInvalidation();
            runOwner = RUN_OWNER_NONE;
        }
        if (abortController === args.abortController) {
            abortController = null;
        }
    }
}

/**
 * HTTP handler for the Asset Opportunity run. Mirrors `handleRunRequest` but
 * validates the asset-opportunity-specific options, then dispatches to the
 * per-asset multi-strategy job.
 */
async function handleAssetOpportunityRunRequest(
    res: ViteHttpResponse,
    body: FinderAssetOpportunityRequestBody,
    runLogRoot: string,
): Promise<void> {
    const prepared = await prepareAssetOpportunityRunPayload(body);

    const owner = acquireRunOwnership();
    const runAbortController = new AbortController();
    abortController = runAbortController;

    const { loadDatasetFullClosed, loadForwardDataset } = createAssetOpportunityDatasetLoaders(prepared);
    const resolvedCapitalSettings = resolveCapitalSettingsFromRaw(
        prepared.capitalSettings as unknown as Record<string, unknown>,
    );
    const rustCanRunInWorkers = prepared.useRustEnginePreference === true
        && !requiresTypescriptEngine(prepared.settings)
        && isRustSupportedTradeSizingMode(resolvedCapitalSettings.sizingMode);
    const singleRunWorkerCount = rustCanRunInWorkers && prepared.symbols.length >= 32
        ? Math.min(
            2,
            resolveAssetOpportunityChunkWorkerCount(
                1,
                prepared.symbols.length,
                process.env,
                totalmem(),
                true,
            ),
        )
        : 1;

    await withFinderRunStream({
        res,
        runId: prepared.runId,
        owner,
        abortController: runAbortController,
        debugEvent: "finder.asset_opportunity.run.failed",
        buildFatal: (message): FinderAssetOpportunityStreamEvent => ({
            type: "asset_fatal",
            runId: prepared.runId,
            error: message,
        }),
        run: (safeWrite) => processFinderAssetOpportunityRun(
            {
                runId: prepared.runId,
                interval: prepared.interval,
                symbols: prepared.symbols,
                options: prepared.options,
                settings: prepared.settings,
                capitalSettings: prepared.capitalSettings,
                selectedStrategies: prepared.selectedStrategies,
                exitStrategyCandidates: prepared.exitStrategyCandidates,
                useRustEnginePreference: prepared.useRustEnginePreference,
                abortSignal: runAbortController.signal,
                loadDataset: loadDatasetFullClosed,
                ...((prepared.foldEnd !== undefined || prepared.researchProgram === "fresh-window")
                    ? { ...(prepared.foldEnd !== undefined ? { foldEnd: prepared.foldEnd } : {}), loadForwardDataset }
                    : {}),
                ...(prepared.researchProgram === "fresh-window" ? { loadDatasetIsRaw: true } : {}),
                ...(prepared.researchProgram ? { researchProgram: prepared.researchProgram } : {}),
                loadSecondaryDataset: loadDatasetFullClosed,
                getProvider: (symbol) => resolveServerProvider(symbol, prepared.providerBySymbol),
                candidatePoolSize: prepared.candidatePoolSize,
                minFreshSupport: prepared.minFreshSupport,
                ...(singleRunWorkerCount > 1
                    ? {
                        batchTaskRunnerFactory: createRealWorkerAssetOpportunityBatchRunner,
                        assetWorkerCount: singleRunWorkerCount,
                        providerBySymbol: Object.fromEntries(
                            [...prepared.providerBySymbol.entries()]
                                .map(([symbol, provider]) => [symbol.trim().toUpperCase(), provider]),
                        ),
                    }
                    : {}),
                runLog: buildFinderRunLogSink(runLogRoot, prepared.runId),
            },
            safeWrite,
            owner,
        ),
    });
}

interface FinderAssetOpportunityBatchRequestBody extends FinderAssetOpportunityRequestBody {
    /** Orchestration-only range; each iteration passes only its own holdout. */
    batch?: unknown;
}

/**
 * HTTP handler for the Asset Opportunity BATCH run. Mirrors
 * `handleAssetOpportunityRunRequest` but additionally validates the inclusive
 * holdout range BEFORE acquiring ownership, then dispatches one sequential
 * server job over every holdout value under the same run id.
 */
async function handleAssetOpportunityBatchRunRequest(
    res: ViteHttpResponse,
    body: FinderAssetOpportunityBatchRequestBody,
    archiveRoot: string,
    runLogRoot: string,
): Promise<void> {
    // Validates the inclusive holdout range + legacy archive-sort field BEFORE
    // acquiring ownership so malformed input can never start heavy work.
    const prepared = await prepareAssetOpportunityRunPayload(body, { validate: true });
    const batchRange = prepared.batchRange!;
    const archiveSort = ASSET_OPPORTUNITY_ALL_SORTS;

    const owner = acquireRunOwnership();
    const runAbortController = new AbortController();
    abortController = runAbortController;

    const { loadDatasetFullClosed, loadForwardDataset } = createAssetOpportunityDatasetLoaders(prepared);

    await withFinderRunStream({
        res,
        runId: prepared.runId,
        owner,
        abortController: runAbortController,
        debugEvent: "finder.asset_opportunity_batch.run.failed",
        buildFatal: (message): FinderAssetOpportunityBatchStreamEvent => ({
            type: "asset_batch_fatal",
            runId: prepared.runId,
            error: message,
            holdoutBars: null,
            completedIterations: 0,
        }),
        run: (safeWrite) => processFinderAssetOpportunityBatchRun(
            {
                runId: prepared.runId,
                interval: prepared.interval,
                symbols: prepared.symbols,
                options: prepared.options,
                settings: prepared.settings,
                capitalSettings: prepared.capitalSettings,
                selectedStrategies: prepared.selectedStrategies,
                exitStrategyCandidates: prepared.exitStrategyCandidates,
                useRustEnginePreference: prepared.useRustEnginePreference,
                abortSignal: runAbortController.signal,
                loadDataset: loadDatasetFullClosed,
                ...((prepared.foldEnd !== undefined || prepared.researchProgram === "fresh-window")
                    ? { ...(prepared.foldEnd !== undefined ? { foldEnd: prepared.foldEnd } : {}), loadForwardDataset }
                    : {}),
                ...(prepared.researchProgram === "fresh-window" ? { loadDatasetIsRaw: true } : {}),
                ...(prepared.researchProgram ? { researchProgram: prepared.researchProgram } : {}),
                ...(prepared.batchRole ? { batchRole: prepared.batchRole } : {}),
                ...(prepared.foldEnd !== undefined || prepared.researchProgram === "fresh-window"
                    ? {
                        dataSyncSnapshot: process.env.FINDER_DATA_SYNC_SNAPSHOT ?? "unknown",
                        gitCommit: process.env.GIT_COMMIT ?? "unknown",
                    }
                    : {}),
                loadSecondaryDataset: loadDatasetFullClosed,
                getProvider: (symbol) => resolveServerProvider(symbol, prepared.providerBySymbol),
                candidatePoolSize: prepared.candidatePoolSize,
                minFreshSupport: prepared.minFreshSupport,
                archiveSort,
                runLog: buildFinderRunLogSink(runLogRoot, prepared.runId),
                batch: { startHoldoutBars: batchRange.start, endHoldoutBars: batchRange.end },
                // Parallel holdout sweep: real workers when the resolved count
                // exceeds 1 (see resolveAssetOpportunityBatchWorkerCount and
                // the FINDER_ASSET_BATCH_WORKERS override). The plain provider
                // map feeds worker task payloads; functions cannot cross the
                // worker boundary. ALWAYS present (even empty) so the
                // worker-side getProvider mirrors resolveServerProvider's
                // binance default instead of disabling cross-symbol fetch.
                batchTaskRunnerFactory: createRealWorkerAssetOpportunityBatchRunner,
                providerBySymbol: Object.fromEntries(
                    [...prepared.providerBySymbol.entries()]
                        .map(([symbol, provider]) => [symbol.trim().toUpperCase(), provider]),
                ),
                ...(prepared.foldSchedule ? { foldSchedule: prepared.foldSchedule } : {}),
            },
            safeWrite,
            owner,
            archiveRoot,
        ),
    });
}

/**
 * Clamp candidatePoolSize to the server-side bound. Default 10 per the plan.
 */
function clampCandidatePoolSize(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
    return Math.max(1, Math.min(50, Math.floor(raw)));
}

/**
 * Clamp minFreshSupport to the server-side bound. Default 2 per the plan.
 */
function clampMinFreshSupport(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 2;
    return Math.max(1, Math.min(50, Math.floor(raw)));
}

/** Normalize the browser's Asset Opportunity archive sort selection. */
function normalizeAssetOpportunityArchiveSort(
    raw: unknown,
): FinderAssetOpportunityArchiveSort | null {
    if (raw === undefined || raw === null || raw === "") return null;
    if (raw === ASSET_OPPORTUNITY_ALL_SORTS) return ASSET_OPPORTUNITY_ALL_SORTS;
    if (
        typeof raw !== "string" ||
        !getAssetOpportunityResortMetrics().includes(raw as FinderAssetOpportunityResortMetric)
    ) {
        throw new HttpStatusError(400, "Invalid Asset Opportunity archive sort metric.");
    }
    return raw as FinderAssetOpportunityResortMetric;
}

function resolveAssetOpportunityArchiveSorts(): Array<FinderAssetOpportunityResortMetric | null> {
    return [null, ...getAssetOpportunityResortMetrics()];
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

interface FinderUniverseRequestBody {
    symbols: unknown;
    interval: unknown;
    options: unknown;
    settings: unknown;
    capitalSettings: unknown;
    /** Legacy single-strategy field; still accepted (normalized to a 1-list). */
    strategyKey?: unknown;
    /** Ordered multi-strategy field (preferred over `strategyKey`). */
    strategyKeys?: unknown;
    /** Required browser-generated job id. */
    runId?: unknown;
    exitStrategyKeys?: unknown;
    useRustEnginePreference?: unknown;
    /**
     * Browser-supplied provider map (symbol -> provider label) for the
     * cross-symbol mismatch guard.
     */
    providerBySymbol?: unknown;
}

async function handleRunRequest(res: ViteHttpResponse, body: FinderUniverseRequestBody): Promise<void> {
    if (runOwner !== RUN_OWNER_NONE) {
        throw new HttpStatusError(409, "A Finder universe run is already running. Use Stop first.");
    }

    const runId = parseRunId(body.runId);
    // Consume a pending Stop that arrived before this run acquired ownership.
    // The marker closes the Stop-before-ownership race without an unbounded
    // cancellation set: only the latest pending stop run id is retained.
    if (consumePendingStopForRun(runId)) {
        throw new HttpStatusError(409, "Finder run was stopped before it started.");
    }

    const symbols = normalizeSymbols(body.symbols);
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "At least one symbol is required.");
    }
    const heapWarning = resolveFinderUniverseHeapWarning(symbols.length);
    if (heapWarning) {
        throw new HttpStatusError(507, heapWarning);
    }
    const interval = parseInterval(body.interval);
    const strategyKeys = parseStrategyKeys(body.strategyKeys, body.strategyKey);
    const selectedStrategies = await resolveSelectedStrategies(strategyKeys);
    const parsedOptions = parseOptions(body.options);
    assertUniverseOptions(parsedOptions);
    // `symbols` exists both at the request top level and inside FinderOptions.
    // Use the validated, heap-guarded top-level list as the single source of
    // truth so a direct caller cannot bypass the heap guard with a tiny outer
    // list and a large nested universe list.
    const options = withCanonicalUniverseSymbols(parsedOptions, symbols);
    const settings = (body.settings ?? {}) as BacktestSettings;
    const capitalSettings = (body.capitalSettings ?? {}) as CapitalSettings;
    const useRustEnginePreference = body.useRustEnginePreference === true;

    const exitStrategyCandidates = await resolveExitStrategyCandidates(body.exitStrategyKeys);
    const providerBySymbol = parseProviderBySymbol(body.providerBySymbol);

    // Setup above includes asynchronous strategy loading. A Stop can arrive
    // after the first pending-stop check but before ownership is acquired, so
    // check once more at the ownership boundary.
    if (consumePendingStopForRun(runId)) {
        throw new HttpStatusError(409, "Finder run was stopped before it started.");
    }

    const owner = acquireRunOwnership();
    const runAbortController = new AbortController();
    abortController = runAbortController;

    // The browser `FinderManager.runUniverseFinder` loadDataset wrapper
    // applies sliceFinderDataWindow(data, options.dataSlice) before IS
    // evaluation. The server loader returns the RAW series; apply the same
    // slice here so browser/server results match for half-window / OOS /
    // data-slice runs. The OOS pass resolves its OWN complementary slice and
    // applies it inside the OOS loader wrapper (not here).
    const dataSlice = (options.dataSlice ?? "all") as FinderDataSlice;
    const loadDatasetWithSlice = (sym: string, intv: string, signal?: AbortSignal): Promise<OHLCVData[]> =>
        loadServerFinderDataset(sym, intv, signal).then((data) => sliceFinderDataWindow(data, dataSlice));

    await withFinderRunStream({
        res,
        runId,
        owner,
        abortController: runAbortController,
        buildFatal: (message): FinderStreamEvent => ({ type: "fatal", runId, error: message }),
        run: (safeWrite) => processFinderUniverseRun(
            {
                runId,
                interval,
                symbols,
                options,
                settings,
                capitalSettings,
                selectedStrategies,
                exitStrategyCandidates,
                useRustEnginePreference,
                abortSignal: runAbortController.signal,
                loadDataset: loadDatasetWithSlice,
                // OOS loads the RAW series and slices inside the wrapper
                // (resolveUniverseOosSlice + sliceFinderDataWindow). Reuse the
                // same server loader so IS/OOS share the bounded disk cache.
                loadOosDataset: (sym, intv, signal) => loadServerFinderDataset(sym, intv, signal),
                getProvider: (symbol) => resolveServerProvider(symbol, providerBySymbol),
                generateParamSets: (defaultParams, finderOptions) =>
                    paramSpace.generateParamSets(defaultParams, finderOptions),
            },
            safeWrite,
            owner,
        ),
    });
}

function rememberLocalApiOriginFromRequest(req: { headers?: Record<string, unknown>; socket?: { localAddress?: string; localPort?: number } | null }): void {
    rememberLoopbackOriginFromRequest(req);
}

async function handleStopRequest(runId: unknown): Promise<{ ok: boolean; stopped: boolean }> {
    // Stop is scoped by run id: a mismatched run id must not stop the active
    // job (a stale tab cannot cancel a newer run).
    const requestedRunId = parseRunId(runId);
    const runWasActive = runOwner !== RUN_OWNER_NONE;
    if (runWasActive && (!runState || runState.runId !== requestedRunId)) {
        return { ok: false, stopped: false };
    }

    if (runWasActive && abortController) {
        try {
            abortController.abort();
        } catch {
            /* best-effort */
        }
    }
    if (!runWasActive && runState?.runId !== requestedRunId) {
        // Stop arrived before the matching run acquired ownership. Record
        // the run id so the run request can finish cancelled instead of
        // starting heavy work (Stop-before-ownership race closer).
        pendingStopRunId = requestedRunId;
    }
    return { ok: true, stopped: runWasActive };
}

/**
 * Status snapshot for `GET /api/finder/status?runId=...`. Reattach polling
 * passes the active run id; a mismatched run id returns 404 (handled by the
 * HTTP layer). A request WITHOUT a run id returns the legacy ad-hoc
 * introspection object for `curl` debugging; the browser reattach path must
 * never use the unscoped form.
 *
 * In-progress snapshots are SUMMARY-ONLY (candidate counts, never the
 * per-symbol payload) so polling stays small. The terminal snapshot carries
 * the authoritative final candidate slice once.
 */
function handleStatusRequest(runIdFilter: string | null): FinderRunStatusSnapshot | { ok: false; error: string } {
    if (!runState) {
        return { ok: false, error: "No Finder run state available." };
    }
    // Scoped form (runId provided): only return a matching active/last run.
    if (runIdFilter !== null) {
        if (runState.runId !== runIdFilter) {
            return { ok: false, error: "Run id does not match the active or last Finder run." };
        }
        return buildStatusSnapshot();
    }
    // Unscoped form: legacy `curl` introspection. Only meaningful when there
    // is an active/last run; the browser reattach path must pass a runId.
    return buildStatusSnapshot();
}

function buildStatusSnapshot(): FinderRunStatusSnapshot {
    const running = runOwner !== RUN_OWNER_NONE;
    const terminal = runState!.finishedAt !== null;
    const state = runState!;
    const jobKind = state.jobKind ?? "symbol_universe";
    const assetOpportunityKind = jobKind === "asset_opportunity" || jobKind === "asset_opportunity_batch";
    return {
        ok: true,
        running,
        terminal,
        runId: state.runId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        phase: state.phase,
        interval: state.interval,
        jobKind,
        ...(state.researchProgram ? { researchProgram: state.researchProgram } : {}),
        ...(state.judgmentStatus ? { judgmentStatus: state.judgmentStatus } : {}),
        ...(state.judgmentInvalidReasons ? { judgmentInvalidReasons: state.judgmentInvalidReasons } : {}),
        ...(state.foldEnd !== undefined ? { foldEnd: state.foldEnd } : {}),
        strategyKeys: state.strategyKeys,
        strategyIndex: state.strategyIndex,
        strategyCount: state.strategyCount,
        totalSymbols: state.totalSymbols,
        progressPercent: state.progressPercent,
        statusText: state.statusText,
        candidateCount: state.candidates.length,
        loadedSymbols: state.loadedSymbols,
        failedSymbols: state.failedSymbols,
        cancelled: state.cancelled,
        // The terminal candidate slice ships ONCE here, only for universe runs.
        // In-progress snapshots return null so polling stays small while a
        // large universe runs. Asset-opportunity terminal snapshots (single
        // and batch) carry the full scalar asset result set of the run / last
        // completed iteration on `terminalAssets` instead.
        terminalCandidates: terminal && jobKind === "symbol_universe" ? state.candidates : null,
        terminalAssets: terminal && assetOpportunityKind ? state.assetResults ?? [] : null,
        summary: state.summary,
        error: state.error,
        diagnostics: state.diagnostics,
        totals: state.totals,
        assetTotals: terminal && assetOpportunityKind ? state.assetTotals ?? null : null,
        assetDiagnostics: terminal && assetOpportunityKind ? state.assetDiagnostics ?? null : null,
        batch: state.batch ?? null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSymbols(raw: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const source = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
    for (const item of source) {
        if (typeof item !== "string") continue;
        const normalized = item.trim().toUpperCase();
        if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            out.push(normalized);
        }
    }
    return out;
}

function parseInterval(raw: unknown): string {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value) {
        throw new HttpStatusError(400, "interval is required.");
    }
    return value;
}

/**
 * Validate the browser-generated run id. Required, non-empty string, bounded
 * length. Persisted by the browser before `fetch` so a reload can identify
 * the same job.
 */
function parseRunId(raw: unknown): string {
    if (typeof raw !== "string") {
        throw new HttpStatusError(400, "runId is required and must be a string.");
    }
    const value = raw.trim();
    if (!value) {
        throw new HttpStatusError(400, "runId is required and must be a non-empty string.");
    }
    if (value.length > MAX_RUN_ID_LENGTH) {
        throw new HttpStatusError(400, `runId must be at most ${MAX_RUN_ID_LENGTH} characters.`);
    }
    return value;
}

/**
 * Parse and validate the ordered multi-strategy key list. Accepts the
 * preferred `strategyKeys` array or the legacy single `strategyKey` (which
 * is normalized to a 1-element list for backward compatibility with a stale
 * browser bundle during deploy). Rejects empty, duplicate, non-string, and
 * unknown keys with a 400 BEFORE acquiring ownership.
 */
function parseStrategyKeys(strategyKeysRaw: unknown, legacyStrategyKey: unknown): string[] {
    let keys: unknown[];
    if (Array.isArray(strategyKeysRaw)) {
        keys = strategyKeysRaw;
    } else if (strategyKeysRaw === undefined && legacyStrategyKey !== undefined) {
        keys = [legacyStrategyKey];
    } else {
        throw new HttpStatusError(400, "strategyKeys must be a non-empty array of strategy keys.");
    }
    if (keys.length === 0) {
        throw new HttpStatusError(400, "strategyKeys must contain at least one strategy.");
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = 0; i < keys.length; i += 1) {
        const item = keys[i]!;
        if (typeof item !== "string") {
            throw new HttpStatusError(400, `strategyKeys[${i}] must be a string.`);
        }
        const trimmed = item.trim();
        if (!trimmed) {
            throw new HttpStatusError(400, `strategyKeys[${i}] must be a non-empty string.`);
        }
        if (seen.has(trimmed)) {
            throw new HttpStatusError(400, `strategyKeys must not contain duplicates: "${trimmed}".`);
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

async function resolveSelectedStrategies(keys: string[]): Promise<FinderSelectedStrategy[]> {
    const out: FinderSelectedStrategy[] = [];
    for (const key of keys) {
        const strategy = await resolveStrategy(key);
        out.push({ key, name: strategy.name, strategy });
    }
    return out;
}

function parseOptions(raw: unknown): FinderOptions {
    if (!raw || typeof raw !== "object") {
        throw new HttpStatusError(400, "options is required.");
    }
    const options = raw as FinderOptions;
    return clampFinderOptions(options);
}

/**
 * Structural validation of the nested universe block BEFORE any field is
 * dereferenced. Each check throws an intentional 400 with a specific message.
 */
function assertUniverseOptions(options: FinderOptions): void {
    if (options.scope !== "symbol_universe") {
        throw new HttpStatusError(400, "Server-side Finder requires scope 'symbol_universe'.");
    }
    const universe = options.universe as unknown;
    if (!universe || typeof universe !== "object" || Array.isArray(universe)) {
        throw new HttpStatusError(400, "options.universe must be an object.");
    }
    const symbols = (universe as { symbols?: unknown }).symbols;
    if (!Array.isArray(symbols)) {
        throw new HttpStatusError(400, "options.universe.symbols must be an array.");
    }
    if (symbols.length === 0) {
        throw new HttpStatusError(400, "options.universe.symbols must be a non-empty array.");
    }
    for (let i = 0; i < symbols.length; i += 1) {
        if (typeof symbols[i] !== "string") {
            throw new HttpStatusError(400, `options.universe.symbols[${i}] must be a string.`);
        }
    }
}

function withCanonicalUniverseSymbols(options: FinderOptions, symbols: string[]): FinderOptions {
    return {
        ...options,
        universe: {
            ...options.universe!,
            symbols: [...symbols],
        },
    };
}

async function resolveStrategy(strategyKey: string): Promise<Strategy> {
    // Use `loadBuiltInStrategyByKey` (not `ensureBuiltInStrategyLoaded`) so the
    // strategy is registered into `strategyRegistry`, mirroring the Batch
    // plugin. The server runs cold (no strategy panel UI) so the registry is
    // empty until we take the path that registers.
    const strategy = await loadBuiltInStrategyByKey(strategyKey);
    if (!strategy) {
        throw new HttpStatusError(400, `Strategy not loaded: ${strategyKey}`);
    }
    return strategy;
}

async function resolveExitStrategyCandidates(
    rawKeys: unknown,
): Promise<FinderSelectedStrategy[] | undefined> {
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) return undefined;
    const candidates: FinderSelectedStrategy[] = [];
    for (const key of rawKeys) {
        if (typeof key !== "string") continue;
        const strategy = await loadBuiltInStrategyByKey(key);
        if (strategy) {
            candidates.push({ key, name: strategy.name, strategy });
        }
    }
    return candidates.length > 0 ? candidates : undefined;
}

/**
 * Parse the browser-supplied provider map (symbol -> provider label). Returns
 * a normalized map keyed by uppercased symbol. Rejects (400) a non-object or
 * a map with non-string values so a malformed payload can't silently turn the
 * mismatch guard into an allow-all.
 */
function parseProviderBySymbol(raw: unknown): Map<string, string> {
    const out = new Map<string, string>();
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new HttpStatusError(400, "providerBySymbol must be an object mapping symbol -> provider.");
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string") {
            throw new HttpStatusError(400, `providerBySymbol["${key}"] must be a string provider label.`);
        }
        const normalized = key.trim().toUpperCase();
        if (normalized) out.set(normalized, value);
    }
    return out;
}

/**
 * Provider label for cross-symbol strategies' provider-mismatch guard.
 * The browser sends a `providerBySymbol` map with the request so the server
 * applies the SAME mismatch guard the browser does. A symbol present in the
 * map resolves to its real provider; a symbol absent falls back to the
 * default (`binance`).
 */
function resolveServerProvider(symbol: string, providerBySymbol: Map<string, string>): string {
    const normalized = symbol.trim().toUpperCase();
    return providerBySymbol.get(normalized) ?? "binance";
}

/**
 * Build the fire-and-forget JSONL run-log sink for one run. Writes are
 * buffered (line schema identical to `appendFinderRunLogEvent`) with
 * immediate flushes at iteration boundaries; write failures are logged to
 * the debug logger and never propagate, so a disk hiccup can never fail a
 * Finder run.
 */
function buildFinderRunLogSink(root: string, runId: string): FinderRunLogSink {
    return createBufferedFinderRunLogSink(root, runId, {
        onWriteError: (error) => {
            debugLogger.warn("finder.run_log.append_failed", {
                runId,
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function finderVitePlugin(): Plugin {
    return {
        name: "finder-universe-server",
        configureServer(server) {
            registerFinderRoutes(server.middlewares, server.config.root);
        },
        configurePreviewServer(server) {
            registerFinderRoutes(server.middlewares, server.config.root);
        },
    };
}

/**
 * Install all Finder server routes; exposed through {@link __testInternals}
 * (`registerFinderRoutesForTests`) for route-level authorization tests,
 * mirroring the Batch plugin's `registerBatchRoutes` seam.
 *
 * Audit Finding 1 (+ audit Finding 8 helper): every Finder route gates on the
 * loopback/bearer policy enforced inside `registerLocalJsonRoute`, the same
 * policy the Batch, IBKR, and strategy-admin routes enforce — so a Vite dev
 * server exposed via `--host`, tunnel, or reverse proxy cannot be driven into
 * CPU-heavy Finder runs or have results/diagnostics disclosed to a remote
 * caller.
 */
function registerFinderRoutes(middlewares: any, serverRoot?: string): void {
    // The batch archive dir resolves from Vite's configured project root so
    // launching Vite from another working directory cannot write to the wrong
    // archive. Tests call the registration seam without a root and fall back
    // to the process working directory.
    const archiveRoot = serverRoot ?? process.cwd();
    // Per-run JSONL diagnostics log, env-overridable via FINDER_RUN_LOG_DIR
    // (see lib/finder/server/finder-run-log.ts).
    const runLogRoot = resolveFinderRunLogDir(archiveRoot);
    // Audit Finding 1 (+ audit Finding 8 helper): every Finder route gates on
    // the same loopback/bearer policy as the Batch, IBKR, and strategy-admin
    // routes — a Vite dev server exposed via --host, tunnel, or reverse proxy
    // cannot be driven into CPU-heavy Finder runs or have results/diagnostics
    // disclosed to a remote caller. `registerLocalJsonRoute` makes the gate
    // structurally impossible to forget when new routes are added.
    registerLocalJsonRoute(middlewares, "/api/finder/universe-run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
        onAuthorizedRequest: (req) => rememberLocalApiOriginFromRequest(req),
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: async ({ res, body }) => {
            await handleRunRequest(res, body as unknown as FinderUniverseRequestBody);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/finder/asset-opportunity-run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
        onAuthorizedRequest: (req) => rememberLocalApiOriginFromRequest(req),
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: async ({ res, body }) => {
            await handleAssetOpportunityRunRequest(res, body as unknown as FinderAssetOpportunityRequestBody, runLogRoot);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/finder/asset-opportunity-batch-run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: FINDER_BATCH_MAX_BODY_BYTES,
        onAuthorizedRequest: (req) => rememberLocalApiOriginFromRequest(req),
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: async ({ res, body }) => {
            await handleAssetOpportunityBatchRunRequest(
                res,
                body as unknown as FinderAssetOpportunityBatchRequestBody,
                archiveRoot,
                runLogRoot,
            );
        },
    });

    registerLocalJsonRoute(middlewares, "/api/finder/stop", {
        methods: ["POST"],
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: async ({ res, req }) => {
            // Lenient body read: an empty or malformed body is treated as "no
            // runId" rather than a 400, so a legacy caller or a partial POST
            // can still cancel the active run. Read inline (not via
            // `readBody: true`) so this catch survives the helper's strict
            // body-read path.
            const body = await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES).catch(() => ({}));
            const result = await handleStopRequest((body as { runId?: unknown })?.runId);
            sendJson(res, 200, result);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/finder/status", {
        methods: ["GET"],
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: ({ res, url }) => {
            // status exposes run inputs, progress, candidates, and diagnostics.
            const runIdFilter = url.searchParams.has("runId")
                ? url.searchParams.get("runId")
                : null;
            const snapshot = handleStatusRequest(runIdFilter);
            if (snapshot && typeof snapshot === "object" && snapshot.ok === false) {
                sendJson(res, 404, snapshot);
                return;
            }
            sendJson(res, 200, snapshot);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/finder/invalidate-cache", {
        methods: ["POST"],
        unauthorizedMessage: "Unauthorized: Finder routes are local-only.",
        onAuthorized: ({ res }) => {
            // While a run owns the server, defer the clear to the next
            // generation-safe run boundary so an active job never mixes
            // pre-sync and post-sync dataset versions (audit Finding 3).
            if (runOwner !== RUN_OWNER_NONE) {
                pendingDatasetCacheInvalidation = true;
                debugLogger.event("finder.server.dataset_cache_invalidation_deferred");
                sendJson(res, 200, { ok: true, deferred: true });
                return;
            }
            flushPendingDatasetCacheInvalidation();
            sendJson(res, 200, { ok: true });
        },
    });
}

// Exported for tests only. `processFinderUniverseRun` consults module-scope
// `runOwner` for cancellation, mirroring the Batch plugin pattern.
export const __testInternals = {
    handleStopRequest,
    handleStatusRequest,
    clearServerFinderDatasetCaches,
    registerFinderRoutesForTests: registerFinderRoutes,
    assertUniverseOptions,
    parseStrategyKeys,
    parseRunId,
    parseAssetOpportunityResearchProgram,
    parseAssetOpportunityFreshWindowBatchRole,
    parseAssetOpportunityFoldEnd,
    parseAssetOpportunityFreshFoldSchedule,
    consumePendingStopForRun,
    writeStreamEventBestEffort,
    withCanonicalUniverseSymbols,
    setRunOwnerForTests(owner: number): void {
        runOwner = owner;
    },
    getPendingDatasetCacheInvalidation(): boolean {
        return pendingDatasetCacheInvalidation;
    },
    flushPendingDatasetCacheInvalidation,
    acquireRunOwnershipForTests(): number {
        return acquireRunOwnership();
    },
    setRunStateForTests(snapshot: FinderRunSnapshot | null): void {
        runState = snapshot;
    },
    getRunStateForTests(): FinderRunSnapshot | null {
        return runState;
    },
    resetRunStateForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runState = null;
        abortController = null;
        pendingStopRunId = null;
        pendingDatasetCacheInvalidation = false;
    },
};
