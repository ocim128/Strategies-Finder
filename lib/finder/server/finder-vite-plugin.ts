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
import { debugLogger } from "../../debug-logger";
import {
    beginNdjsonStream,
    HttpStatusError,
    readJsonBody,
    sendCaughtErrorJson,
    sendJson,
    type ViteHttpResponse,
} from "../../vite-http-utils";
import { runFinderUniverseExecution } from "../finder-runner-universe";
import type { FinderSelectedStrategy } from "../finder-runner";
import { FinderParamSpace } from "../finder-param-space";
import { sliceFinderDataWindow } from "../finder-manager-logic";
import type { CapitalSettings } from "../../types/backtest";
import type {
    FinderDiagnostics,
    FinderDataSlice,
    FinderOptions,
    FinderUniverseCandidate,
} from "../../types/finder";
import type { BacktestSettings, OHLCVData, Strategy, StrategyParams } from "../../types/strategies";
import { loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import {
    clearServerFinderDatasetCaches,
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAP_MB = 1024 * 1024;

/** Bound on run id length (defensive; browser-generated ids are short). */
const MAX_RUN_ID_LENGTH = 128;

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

export type FinderRunSnapshot = {
    runId: string;
    startedAt: number;
    /** Set when the run reaches a terminal snapshot (done/cancelled/fatal). */
    finishedAt: number | null;
    interval: string;
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
};

// ---------------------------------------------------------------------------
// Run core (factored out of the HTTP handlers for testability)
// ---------------------------------------------------------------------------

type StreamWriter = (event: FinderStreamEvent) => void;

function writeStreamEventBestEffort(
    stream: { write(event: FinderStreamEvent): void },
    event: FinderStreamEvent,
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
    const jobDatasetCacheStats = {
        requests: 0,
        hits: 0,
        misses: 0,
        successfulLoads: 0,
        failedLoads: 0,
        uniqueBarsLoaded: 0,
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
        diagnostics: null,
        cancelled: false,
        summary: null,
        error: null,
        totals: null,
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
    let failedSymbolsTotal = 0;
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
            failedSymbolsTotal += output.failedSymbols.length;
            if (output.diagnostics) diagnosticsParts.push(output.diagnostics);

            // Re-sort + bound the merged snapshot to topN so `runState` never
            // retains candidates that would later be evicted.
            snapshot.candidates = [...boundedCompleted];

            snapshot.loadedSymbols = loadedSymbolsMax;
            snapshot.failedSymbols = failedSymbolsTotal;

            debugLogger.event("finder.server.strategy.complete", {
                runId: input.runId,
                strategyKey: selectedStrategy.key,
                strategyIndex,
                strategyCount,
                loadedSymbols: output.loadedSymbols,
                failedSymbols: output.failedSymbols.length,
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
            };
        }
        snapshot.diagnostics = combinedDiagnostics;

        const summary = cancelled
            ? `Cancelled — ${terminalScalar.length} survivors`
            : `Done — ${terminalScalar.length} survivors, ${failedSymbolsTotal} failed symbols`;
        snapshot.summary = summary;
        snapshot.totals = {
            loadedSymbols: loadedSymbolsMax,
            failedSymbols: failedSymbolsTotal,
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
                failedSymbols: failedSymbolsTotal,
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
            failedSymbols: failedSymbolsTotal,
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
            failedSymbols: failedSymbolsTotal,
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

    const owner = ++runOwnerGen;
    runOwner = owner;
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

    let stream: ReturnType<typeof beginNdjsonStream> | null = null;
    let streamWritable = true;
    try {
        stream = beginNdjsonStream(res);
        const responseWithEvents = res as ViteHttpResponse & {
            on?: (event: string, listener: () => void) => void;
        };
        if (typeof responseWithEvents.on === "function") {
            const markDisconnected = () => { streamWritable = false; };
            responseWithEvents.on("close", markDisconnected);
            responseWithEvents.on("error", markDisconnected);
        }
        const safeWrite = (event: FinderStreamEvent): void => {
            if (!streamWritable) return;
            if (!writeStreamEventBestEffort(stream!, event, runId)) {
                streamWritable = false;
            }
        };
        await processFinderUniverseRun(
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
        );
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
        try {
            if (!streamWritable) return;
            stream.end({ type: "fatal", runId, error: message });
        } catch {
            /* best-effort */
        }
    } finally {
        if (runOwner === owner) {
            runOwner = RUN_OWNER_NONE;
        }
        // A stopped run releases ownership immediately so another run can
        // begin while the old handler unwinds. Do not let old cleanup erase
        // the new run's controller.
        if (abortController === runAbortController) {
            abortController = null;
        }
    }
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
    if (runWasActive) {
        runOwner = RUN_OWNER_NONE;
    } else if (runState?.runId !== requestedRunId) {
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
    return {
        ok: true,
        running,
        terminal,
        runId: runState!.runId,
        startedAt: runState!.startedAt,
        finishedAt: runState!.finishedAt,
        phase: runState!.phase,
        interval: runState!.interval,
        strategyKeys: runState!.strategyKeys,
        strategyIndex: runState!.strategyIndex,
        strategyCount: runState!.strategyCount,
        totalSymbols: runState!.totalSymbols,
        progressPercent: runState!.progressPercent,
        statusText: runState!.statusText,
        candidateCount: runState!.candidates.length,
        loadedSymbols: runState!.loadedSymbols,
        failedSymbols: runState!.failedSymbols,
        cancelled: runState!.cancelled,
        // The terminal candidate slice ships ONCE here. In-progress snapshots
        // return null so polling stays small while a large universe runs.
        terminalCandidates: terminal ? runState!.candidates : null,
        summary: runState!.summary,
        error: runState!.error,
        diagnostics: runState!.diagnostics,
        totals: runState!.totals,
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function finderVitePlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/finder/universe-run", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                rememberLocalApiOriginFromRequest(req);
                await handleRunRequest(res as ViteHttpResponse, await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES) as unknown as FinderUniverseRequestBody);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/finder/stop", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const body = await readJsonBody(req, FINDER_BATCH_MAX_BODY_BYTES).catch(() => ({}));
                const result = await handleStopRequest((body as { runId?: unknown })?.runId);
                sendJson(res, 200, result);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/finder/status", async (req: any, res: any) => {
            if (req.method !== "GET") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            try {
                const url = new URL(req.url, "http://localhost");
                const runIdFilter = url.searchParams.has("runId")
                    ? url.searchParams.get("runId")
                    : null;
                const snapshot = handleStatusRequest(runIdFilter);
                if (snapshot && typeof snapshot === "object" && snapshot.ok === false) {
                    sendJson(res, 404, snapshot);
                    return;
                }
                sendJson(res, 200, snapshot);
            } catch (error) {
                sendCaughtErrorJson(res, error);
            }
        });

        middlewares.use("/api/finder/invalidate-cache", async (req: any, res: any) => {
            if (req.method !== "POST") {
                sendJson(res, 405, { ok: false, error: "Method not allowed" });
                return;
            }
            clearServerFinderDatasetCaches();
            debugLogger.event("finder.server.dataset_cache_invalidated");
            sendJson(res, 200, { ok: true });
        });
    };

    return {
        name: "finder-universe-server",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}

// Exported for tests only. `processFinderUniverseRun` consults module-scope
// `runOwner` for cancellation, mirroring the Batch plugin pattern.
export const __testInternals = {
    handleStopRequest,
    handleStatusRequest,
    clearServerFinderDatasetCaches,
    assertUniverseOptions,
    parseStrategyKeys,
    parseRunId,
    consumePendingStopForRun,
    writeStreamEventBestEffort,
    withCanonicalUniverseSymbols,
    setRunOwnerForTests(owner: number): void {
        runOwner = owner;
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
    },
};
