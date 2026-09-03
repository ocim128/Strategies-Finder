import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import { isRustSupportedTradeSizingMode, type CapitalSettings } from "../types/backtest";
import { timeToNumber } from "../strategies/backtest/backtest-utils";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import {
    EFFECTIVE_BACKTEST_DEFAULTS,
    resolveBacktestSettingsFromRaw,
} from "../backtest-settings-resolver";
import { getTypescriptEngineRequirementReasons } from "../rust-settings-sanitizer";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-artifact";
import {
    atomicWriteJsonSync,
    cleanOldArtifacts,
    computeRunFingerprint,
    getRunDir,
    iterateRunCompactArtifacts,
    iterateRunRawCompactArtifacts,
    loadManifest,
    reconcileInterruptedManifestsOnStartup,
    saveManifest,
} from "./sp500-top-mean-artifact-store";
import { enumerateSp500Pairs, type CoverageCounts } from "./sp500-pair-enumerator";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import {
    TopMeanWorkerPool,
    resolveTopMeanShardSize,
    resolveTopMeanWorkerCount,
} from "./sp500-top-mean-worker-pool";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdReplayResult,
    type OpenScoreUsdEventDetail,
    type OpenScoreUsdOngoingEventDetail,
    type CandidateOutcomeRecord,
    type PoolSnapshotRecord,
    type OpenScoreUsdLatestSelections,
    type AssetSelectionSummary,
    type ReplayComparison,
} from "./batch-open-score-usd-replay-engine";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import {
    computeCurrentTopMeanSnapshot,
    type CurrentTopMeanResult,
} from "./sp500-top-mean-current-snapshot";
import {
    formatTopMeanPerformanceLines,
    type TopMeanPerformanceDiagnostic,
} from "./sp500-top-mean-performance";
import {
    archiveCompletedTopMeanRun,
    createTopMeanPhase0bArchiveWriter,
    findRegistryPoolMatch,
    resolveTopMeanArchiveLogDir,
    resolveTopMeanWindowDesignation,
    sha256LineList,
    type TopMeanArchiveManifest,
    type TopMeanArchiveOutcome,
    type TopMeanPhase0bArchiveWriter,
} from "./sp500-top-mean-archive-log";
import { debugLogger } from "../debug-logger";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    MAX_ACTIVE_TIE_VERSION,
} from "./max-active-research-contract";

export interface TopMeanCoordinatorRunRequest {
    runId: string;
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    interval: string;
    horizons: number[];
    workerCount?: number;
    maxPairs?: number;
    pairListText?: string;
    resume?: boolean;
    saveArchiveLog?: boolean;
    useRustEnginePreference?: boolean;
    /**
     * Optional decision-event date window (unix seconds, inclusive) applied
     * ONLY to the phase-3 OPEN_SCORE USD replay. Pair backtests (phase 2)
     * always cover full history. Mirrors the OPEN_SCORE USD sampleFromSec /
     * sampleToSec semantics; undefined = full history.
     */
    sampleFromSec?: number;
    sampleToSec?: number;
}

export interface TopMeanHorizonSummary {
    horizon: number;
    events: number;
    topMean: ReplayComparison;
    topAssets: AssetSelectionSummary[];
}

export interface TopMeanAnnualReplayWindow {
    year: number;
    sampleFromSec: number;
    sampleToSec: number;
}

export interface TopMeanAnnualReplaySummary extends TopMeanAnnualReplayWindow {
    horizons: TopMeanHorizonSummary[];
    eventDetails?: OpenScoreUsdEventDetail[];
    warnings: string[];
    reportLines: string[];
}

export interface TopMeanResultSummary {
    runId: string;
    completed: boolean;
    archiveComplete: boolean;
    archiveRequested?: boolean;
    archiveDir?: string;
    archiveError?: string;
    counts: CoverageCounts;
    horizons: TopMeanHorizonSummary[];
    /** Calendar-year OPEN_SCORE USD reports clipped to the selected From/To range. */
    annualReports?: TopMeanAnnualReplaySummary[];
    /** Full selected-window scalar rows for the on-demand OPEN_SCORE details UI. */
    openScoreEventDetails?: OpenScoreUsdEventDetail[];
    /** TOP_MEAN selections whose requested horizons are not complete yet. */
    ongoingEventDetails?: OpenScoreUsdOngoingEventDetail[];
    /** Full-window Phase 0b pool snapshots, coordinator-only diagnostics. */
    poolSnapshots?: PoolSnapshotRecord[];
    /** Full-window Phase 0b candidate outcomes, coordinator-only diagnostics. */
    candidateOutcomes?: CandidateOutcomeRecord[];
    warnings: string[];
    reportLines: string[];
    /** Latest-event picks for the useful OPEN_SCORE selector arms. */
    latestSelections?: OpenScoreUsdLatestSelections | null;
    /** Server-measured wall time, worker cost, throughput, and cache counters. */
    performance?: TopMeanPerformanceDiagnostic;
    /**
     * Phase-1 current snapshot: TOP_MEAN derived from positions open at the
     * latest common closed candle, computed from compact artifacts. Separate
     * from `horizons` (the historical OPEN_SCORE replay leaderboard).
     * Optional for backward compatibility with older payloads.
     */
    currentSnapshot?: CurrentTopMeanResult;
}

export function buildTopMeanAnnualReplayWindows(
    sampleFromSec: number | undefined,
    sampleToSec: number | undefined,
    nowSec = Math.floor(Date.now() / 1000),
): TopMeanAnnualReplayWindow[] {
    if (typeof sampleFromSec !== "number" || !Number.isFinite(sampleFromSec)) {
        return [];
    }

    const requestedEndSec = typeof sampleToSec === "number" && Number.isFinite(sampleToSec)
        ? sampleToSec
        : nowSec;
    const endSec = Math.min(requestedEndSec, nowSec);
    if (sampleFromSec > endSec) {
        return [];
    }

    const firstYear = new Date(sampleFromSec * 1000).getUTCFullYear();
    const lastYear = new Date(endSec * 1000).getUTCFullYear();
    const windows: TopMeanAnnualReplayWindow[] = [];
    for (let year = firstYear; year <= lastYear; year += 1) {
        const yearFromSec = Math.floor(Date.UTC(year, 0, 1) / 1000);
        const yearToSec = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
        windows.push({
            year,
            sampleFromSec: Math.max(sampleFromSec, yearFromSec),
            sampleToSec: Math.min(endSec, yearToSec),
        });
    }
    return windows;
}

/**
 * Alternate replay target traversal so a bounded LRU retains the tail of one
 * pass as the head of the next. Result aggregation is asset-keyed and
 * deterministic, so traversal direction does not change selector semantics.
 */
export function orderTopMeanReplayTargets<T>(
    targets: readonly T[],
    passIndex: number,
): readonly T[] {
    return passIndex % 2 === 0 ? targets : targets.slice().reverse();
}

export interface TopMeanStatusResponse {
    runId: string;
    status: "running" | "completed" | "interrupted" | "failed";
    phase: "preflight" | "backtesting" | "replay" | "completed" | "interrupted" | "failed";
    fingerprint?: string;
    counts?: CoverageCounts;
    pairTotals: number;
    completedPairs: number;
    failedPairs: number;
    progressText: string;
    workerCount: number;
    /** Preference from the request (what the UI asked for). */
    requestedEngineMode: string;
    /**
     * Best-effort label for the engine that actually ran completed pairs.
     * "mixed" when both rust and typescript completed at least one pair.
     * Falls back to requested mode when no completed pair has reported yet.
     */
    actualEngineMode: string;
    engineUsage: { rust: number; typescript: number };
    archiveComplete?: boolean;
    archiveRequested?: boolean;
    archiveDir?: string;
    archiveError?: string;
    performance?: TopMeanPerformanceDiagnostic;
    error?: string;
    result?: TopMeanResultSummary;
}

let activeEngineInstance: TopMeanCoordinatorEngine | null = null;

export function getActiveTopMeanCoordinatorEngine(): TopMeanCoordinatorEngine | null {
    return activeEngineInstance;
}

export class TopMeanCoordinatorEngine {
    private pool: TopMeanWorkerPool | null = null;
    private isStopped = false;
    private currentPhase: "preflight" | "backtesting" | "replay" | "completed" | "interrupted" | "failed" = "preflight";
    private progressText = "Initializing preflight...";
    private manifest: TopMeanRunManifest | null = null;
    private counts: CoverageCounts | null = null;
    private resultSummary: TopMeanResultSummary | null = null;
    /**
     * Phase-1 current snapshot, captured as soon as the artifact reducer
     * finishes (step 2b) and BEFORE the historical replay. Held at the
     * instance level so the /status handler and the fatal path can surface
     * the snapshot even if the replay throws.
     */
    private currentSnapshotResult: CurrentTopMeanResult | null = null;
    /** Aggregated actual engine usage across completed pair backtests. */
    private engineUsage: { rust: number; typescript: number } = { rust: 0, typescript: 0 };
    private performanceStartedAtMs = 0;
    private performanceDiagnostic: TopMeanPerformanceDiagnostic | null = null;
    private canonicalAssets: string[] = [];
    private runFingerprint: string | null = null;
    private executionPairs: string[] = [];
    private matchedPoolVersion: string | null = null;
    private matchedPoolAlgorithm: string | null = null;
    private matchedPoolSeed: number | null = null;
    private resolvedBacktestSettings: BacktestSettings | null = null;
    private resolvedCapitalSettings: CapitalSettings | null = null;
    private latestTargetBarTimeSec: number | null = null;
    private replayCosts = {
        slippageRate: 0,
        commissionRate: 0,
        slippageBps: 0,
        commissionPercent: 0,
    };
    private readonly archiveRequested: boolean;
    private archiveRoot: string | null = null;

    constructor(
        private readonly _request: TopMeanCoordinatorRunRequest,
        private readonly baseDir?: string,
    ) {
        this.archiveRequested = _request.saveArchiveLog !== false;
    }

    public get request(): TopMeanCoordinatorRunRequest {
        return this._request;
    }

    public getStatus(): TopMeanStatusResponse {
        return {
            runId: this._request.runId,
            status: this.manifest?.status || (this.isStopped ? "interrupted" : "running"),
            phase: this.currentPhase,
            fingerprint: this.manifest?.fingerprint,
            counts: this.counts || undefined,
            pairTotals: this.counts?.pairCount || 0,
            completedPairs: this.manifest?.completedPairsCount || 0,
            failedPairs: this.manifest?.failedPairsCount || 0,
            progressText: this.progressText,
            workerCount: resolveTopMeanWorkerCount(this._request.workerCount),
            requestedEngineMode: this._request.useRustEnginePreference ? "rust" : "typescript",
            actualEngineMode: this.resolveActualEngineMode(),
            engineUsage: { ...this.engineUsage },
            archiveComplete: this.resultSummary?.archiveComplete ?? this.manifest?.archiveComplete,
            archiveRequested: this.resultSummary?.archiveRequested
                ?? this.manifest?.archiveRequested
                ?? this.archiveRequested,
            archiveDir: this.resultSummary?.archiveDir ?? this.manifest?.archiveDir,
            archiveError: this.resultSummary?.archiveError ?? this.manifest?.archiveError,
            ...(this.performanceDiagnostic
                ? { performance: this.performanceSnapshot() }
                : {}),
            error: this.manifest?.error,
            result: this.resultSummary || undefined,
        };
    }

    private resolveActualEngineMode(): string {
        return this.resolveEngineMode(this.engineUsage);
    }

    private performanceSnapshot(): TopMeanPerformanceDiagnostic {
        const diagnostic = this.performanceDiagnostic!;
        return {
            ...diagnostic,
            totalMs: this.performanceStartedAtMs > 0
                ? performance.now() - this.performanceStartedAtMs
                : diagnostic.totalMs,
            phases: { ...diagnostic.phases },
            replay: { ...diagnostic.replay },
            ...(diagnostic.engine
                ? {
                    engine: {
                        ...diagnostic.engine,
                        actual: this.resolveActualEngineMode(),
                        typescriptRequirementReasons: [...diagnostic.engine.typescriptRequirementReasons],
                    },
                }
                : {}),
            ...(diagnostic.worker
                ? {
                    worker: {
                        ...diagnostic.worker,
                        cache: { ...diagnostic.worker.cache },
                    },
                }
                : {}),
        };
    }

    private resolveEngineMode(usage: { rust: number; typescript: number }): string {
        const { rust, typescript } = usage;
        if (rust > 0 && typescript > 0) return "mixed";
        if (rust > 0) return "rust";
        if (typescript > 0) return "typescript";
        return this._request.useRustEnginePreference ? "rust" : "typescript";
    }

    private absorbEngineUsage(usage: { rust: number; typescript: number } | undefined): void {
        if (!usage) return;
        this.engineUsage.rust += usage.rust;
        this.engineUsage.typescript += usage.typescript;
        if (this.performanceDiagnostic?.engine) {
            this.performanceDiagnostic.engine.actual = this.resolveActualEngineMode();
        }
    }

    private resolveTypescriptRequirementReasons(): string[] {
        const settings = resolveBacktestSettingsFromRaw(
            {
                ...(this._request.backtestSettings as Record<string, unknown>),
                interval: this._request.interval,
            } as BacktestSettings,
            { coerceWithoutUiToggles: true },
        );
        settings.tradeDirection = settings.tradeDirection ?? EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection;
        settings.executionModel = settings.executionModel ?? EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
        this.resolvedBacktestSettings = settings;
        const reasons = getTypescriptEngineRequirementReasons(settings);
        const capital = resolveCapitalSettingsFromRaw(
            this._request.capitalSettings as unknown as Record<string, unknown>,
        );
        this.resolvedCapitalSettings = capital;
        if (!isRustSupportedTradeSizingMode(capital.sizingMode)) {
            reasons.push(`${capital.sizingMode} sizing is not supported by Rust`);
        }
        return reasons;
    }

    private updateManifestEngineTelemetry(manifest: TopMeanRunManifest): void {
        manifest.requestedEngineMode = this._request.useRustEnginePreference ? "rust" : "typescript";
        manifest.actualEngineMode = this.resolveActualEngineMode();
        manifest.engineUsage = { ...this.engineUsage };
        manifest.workerCount = resolveTopMeanWorkerCount(this._request.workerCount);
    }

    private async buildArchiveManifest(): Promise<TopMeanArchiveManifest> {
        const sortedAssets = [...this.canonicalAssets].sort((a, b) => a.localeCompare(b));
        const dataCutoff = this.latestTargetBarTimeSec === null
            ? null
            : new Date(this.latestTargetBarTimeSec * 1000).toISOString();
        const { ensureBuiltInStrategyLoaded } = await import("../strategies/built-in-catalog");
        const strategy = await ensureBuiltInStrategyLoaded(this._request.strategyKey);
        const normalizeApplied = typeof strategy?.normalizeParams === "function";
        return {
            strategy: {
                key: this._request.strategyKey,
                params: normalizeApplied
                    ? strategy!.normalizeParams!(this._request.strategyParams)
                    : this._request.strategyParams,
                normalizeApplied,
            },
            settings: {
                backtest: this.resolvedBacktestSettings ?? this._request.backtestSettings,
                capital: this.resolvedCapitalSettings ?? this._request.capitalSettings,
            },
            pairs: {
                pairs: this.executionPairs,
                executionOrderSha256: sha256LineList(this.executionPairs),
                sortedSetSha256: sha256LineList([...this.executionPairs].sort((a, b) => a.localeCompare(b))),
                source: {
                    kind: this._request.pairListText?.trim() ? "custom_pair_list" : "sp500_default",
                    poolVersion: this.matchedPoolVersion,
                },
                construction: {
                    algorithm: this.matchedPoolAlgorithm,
                    seed: this.matchedPoolSeed,
                },
            },
            catalog: {
                assets: sortedAssets,
                sha256: sha256LineList(sortedAssets),
                warmup: null,
                dataCutoff,
            },
            costs: { ...this.replayCosts },
            windowDesignation: resolveTopMeanWindowDesignation(this._request),
            researchContract: {
                tieVersion: MAX_ACTIVE_TIE_VERSION,
                blockCount: MAX_ACTIVE_BLOCK_COUNT,
                bootstrapSamples: MAX_ACTIVE_BOOTSTRAP_SAMPLES,
                bootstrapSeed: MAX_ACTIVE_BOOTSTRAP_SEED,
            },
        };
    }

    public stop(): void {
        this.isStopped = true;
        if (this.pool) {
            this.pool.cancel();
        }
        if (this.manifest) {
            this.manifest.status = "interrupted";
            this.updateManifestEngineTelemetry(this.manifest);
            this.manifest.updatedAt = Date.now();
            saveManifest(this.manifest, this.baseDir);
        }
        this.currentPhase = "interrupted";
        this.progressText = "Stopped by user";
    }

    public async run(emitNdjson: (event: unknown) => void): Promise<void> {
        this.performanceStartedAtMs = performance.now();
        this.performanceDiagnostic = {
            schema: "sp500_top_mean_performance.v1",
            startedAt: new Date().toISOString(),
            totalMs: 0,
            pairCount: 0,
            completedPairs: 0,
            failedPairs: 0,
            workerCount: resolveTopMeanWorkerCount(this._request.workerCount),
            pairsPerSecond: 0,
            engine: {
                requested: this._request.useRustEnginePreference ? "rust" : "typescript",
                actual: this._request.useRustEnginePreference ? "rust" : "typescript",
                typescriptRequirementReasons: this.resolveTypescriptRequirementReasons(),
            },
            phases: {
                preflightMs: 0,
                backtestingMs: 0,
                snapshotMs: 0,
                replayMs: 0,
                resultWriteMs: 0,
            },
            replay: {
                scanMs: 0,
                eventsMs: 0,
                targetsMs: 0,
                outcomesMs: 0,
                aggregateMs: 0,
                targetLoadMs: 0,
                targetDatasets: 0,
            },
        };
        const preflightStartedAt = performance.now();
        activeEngineInstance = this;
        this.archiveRoot = this.archiveRequested
            ? resolveTopMeanArchiveLogDir(this.baseDir ?? process.cwd())
            : null;
        reconcileInterruptedManifestsOnStartup(this.baseDir);
        cleanOldArtifacts(this.baseDir);
        let phase0bWriter: TopMeanPhase0bArchiveWriter | null = null;
        let phase0bFiles: TopMeanPhase0bArchiveWriter["files"] | undefined;
        let phase0bWriterFailed = false;
        let phase0bWriterError: string | undefined;

        try {
            // 1. Enumeration & Preflight
            this.currentPhase = "preflight";
            this.progressText = this._request.pairListText?.trim()
                ? "Preparing custom TOP_MEAN markets..."
                : "Enumerating S&P 500 assets and pairs...";
            const enumRes = enumerateSp500Pairs({
                interval: this._request.interval,
                maxPairs: this._request.maxPairs,
                pairListText: this._request.pairListText,
                baseDir: this.baseDir,
            });

            this.counts = enumRes.counts;
            this.executionPairs = [...enumRes.canonicalPairs];
            const registryMatch = this._request.pairListText?.trim()
                ? await findRegistryPoolMatch(this.baseDir ?? process.cwd(), this.executionPairs)
                : null;
            this.matchedPoolVersion = registryMatch?.poolVersion ?? null;
            this.matchedPoolAlgorithm = registryMatch?.algorithm ?? null;
            this.matchedPoolSeed = registryMatch?.seed ?? null;
            emitNdjson({ type: "preflight", counts: this.counts });

            if (enumRes.canonicalPairs.length === 0) {
                throw new Error("No canonical pairs available for evaluation.");
            }

            const fingerprint = computeRunFingerprint({
                strategyKey: this._request.strategyKey,
                strategyParams: this._request.strategyParams,
                backtestSettings: this._request.backtestSettings,
                capitalSettings: this._request.capitalSettings,
                interval: this._request.interval,
                useRustEnginePreference: this._request.useRustEnginePreference,
                canonicalAssets: enumRes.eligibleAssets,
            });
            this.canonicalAssets = [...enumRes.eligibleAssets];
            this.runFingerprint = fingerprint;
            if (this.archiveRequested && this.archiveRoot !== null) {
                try {
                    phase0bWriter = await createTopMeanPhase0bArchiveWriter(this.baseDir, this._request.runId);
                } catch (error) {
                    phase0bWriterFailed = true;
                    phase0bWriterError = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("sp500_top_mean.phase0b_writer_failed", {
                        runId: this._request.runId,
                        error: phase0bWriterError,
                    });
                }
            }
            const resolvedWorkerCount = resolveTopMeanWorkerCount(this._request.workerCount);
            const resolvedShardSize = resolveTopMeanShardSize(
                enumRes.canonicalPairs.length,
                resolvedWorkerCount,
            );

            let manifest = loadManifest(this._request.runId, this.baseDir);

            if (this._request.resume && manifest) {
                if (manifest.fingerprint !== fingerprint) {
                    throw new Error("Resume fingerprint mismatch: run settings or universe changed.");
                }
                manifest.status = "running";
            } else {
                manifest = {
                    schema: "top_mean_run_manifest.v1",
                    runId: this._request.runId,
                    status: "running",
                    fingerprint,
                    strategyKey: this._request.strategyKey,
                    interval: this._request.interval,
                    pairCount: enumRes.canonicalPairs.length,
                    // Seed the manifest with the same dynamically resolved size
                    // the worker pool will use so pre-worker status is accurate.
                    shardSize: resolvedShardSize,
                    totalShards: Math.ceil(enumRes.canonicalPairs.length / resolvedShardSize),
                    completedShards: [],
                    failedShards: [],
                    completedPairsCount: 0,
                    failedPairsCount: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            }
            this.manifest = manifest;
            manifest.archiveRequested = this.archiveRequested;
            delete manifest.archiveComplete;
            delete manifest.archiveDir;
            delete manifest.archiveError;
            this.performanceDiagnostic.pairCount = enumRes.canonicalPairs.length;
            this.engineUsage = {
                rust: manifest.engineUsage?.rust ?? 0,
                typescript: manifest.engineUsage?.typescript ?? 0,
            };
            this.updateManifestEngineTelemetry(manifest);
            saveManifest(manifest, this.baseDir);
            this.performanceDiagnostic.phases.preflightMs = performance.now() - preflightStartedAt;

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // 2. Worker Execution Phase
            this.currentPhase = "backtesting";
            this.progressText = `Running backtests across ${enumRes.canonicalPairs.length} pairs...`;

            this.pool = new TopMeanWorkerPool();
            const backtestingStartedAt = performance.now();

            const usage = await this.pool.execute({
                runId: this._request.runId,
                manifest,
                canonicalPairs: enumRes.canonicalPairs,
                strategyKey: this._request.strategyKey,
                strategyParams: this._request.strategyParams,
                backtestSettings: this._request.backtestSettings,
                capitalSettings: this._request.capitalSettings,
                interval: this._request.interval,
                workerCount: this._request.workerCount,
                useRustEnginePreference: this._request.useRustEnginePreference,
                baseDir: this.baseDir,
                onProgress: (completed, total, text) => {
                    this.progressText = text;
                    emitNdjson({
                        type: "progress",
                        phase: "backtesting",
                        completed,
                        total,
                        text: this.progressText,
                    });
                },
            });
            this.performanceDiagnostic.phases.backtestingMs = performance.now() - backtestingStartedAt;
            this.performanceDiagnostic.worker = usage.performance;
            this.performanceDiagnostic.completedPairs = manifest.completedPairsCount;
            this.performanceDiagnostic.failedPairs = manifest.failedPairsCount;
            this.performanceDiagnostic.pairsPerSecond = this.performanceDiagnostic.phases.backtestingMs > 0
                ? manifest.completedPairsCount / (this.performanceDiagnostic.phases.backtestingMs / 1000)
                : 0;
            this.absorbEngineUsage(usage);
            this.updateManifestEngineTelemetry(manifest);
            saveManifest(manifest, this.baseDir);

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // 2b. Current Snapshot (Phase 1): derive TOP_MEAN from positions
            // open at the latest common closed candle, directly from completed
            // compact artifacts. Independent of the historical replay below;
            // does not load pair candles or signals.
            this.currentPhase = "replay";
            this.progressText = "Computing current TOP_MEAN snapshot from artifacts...";
            emitNdjson({ type: "progress", phase: "replay", text: this.progressText });

            const snapshotStartedAt = performance.now();
            const currentSnapshotResult = await computeCurrentTopMeanSnapshot(
                () => iterateRunRawCompactArtifacts(this._request.runId, this.baseDir),
                { shouldStop: () => this.isStopped },
            );
            this.performanceDiagnostic.phases.snapshotMs = performance.now() - snapshotStartedAt;
            this.currentSnapshotResult = currentSnapshotResult;

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // PERSIST + EMIT THE SNAPSHOT BEFORE THE REPLAY PHASE. The replay
            // is an independent historical study that can fail (target-loader
            // outages, dataset gaps) without invalidating the current
            // snapshot. Writing result.json now and emitting a
            // `current_snapshot` event means:
            //   - the /status reattach path can return the snapshot even if
            //     the replay never completes;
            //   - the UI can render the current decision before the (slow)
            //     historical replay finishes;
            //   - a replay failure cannot lose the current snapshot.
            // The replay's later write merges its fields into the same file
            // via `{ ...replayResult, currentSnapshot }`.
            const resultJsonPath = join(getRunDir(this._request.runId, this.baseDir), "result.json");
            const snapshotWriteStartedAt = performance.now();
            atomicWriteJsonSync(resultJsonPath, { currentSnapshot: currentSnapshotResult });
            this.performanceDiagnostic.phases.resultWriteMs += performance.now() - snapshotWriteStartedAt;
            emitNdjson({ type: "current_snapshot", currentSnapshot: currentSnapshotResult });

            // 3. Replay & Asset Selector Study Phase
            this.progressText = "Running OPEN_SCORE USD replay and asset selection analysis...";
            emitNdjson({ type: "progress", phase: "replay", text: this.progressText });
            const replayStartedAt = performance.now();
            type ReplayPhase = "scan" | "events" | "targets" | "outcomes" | "aggregate";
            let activeReplayPhase: ReplayPhase | null = null;
            let activeReplayPhaseStartedAt = replayStartedAt;
            const finishActiveReplayPhase = (): void => {
                if (!activeReplayPhase) return;
                const elapsedMs = performance.now() - activeReplayPhaseStartedAt;
                if (activeReplayPhase === "scan") this.performanceDiagnostic!.replay.scanMs += elapsedMs;
                else if (activeReplayPhase === "events") this.performanceDiagnostic!.replay.eventsMs += elapsedMs;
                else if (activeReplayPhase === "targets") this.performanceDiagnostic!.replay.targetsMs += elapsedMs;
                else if (activeReplayPhase === "outcomes") this.performanceDiagnostic!.replay.outcomesMs += elapsedMs;
                else this.performanceDiagnostic!.replay.aggregateMs += elapsedMs;
                activeReplayPhase = null;
            };

            const eligibleTargets = enumRes.eligibleTargets;
            const requestInterval = this._request.interval;

            const targetPerformance = this.performanceDiagnostic;
            // A large custom universe can exceed the shared 64-entry data LRU.
            // Keep this cache scoped to one coordinator replay so annual
            // windows reuse parsed OHLCV without changing process-wide cache
            // caps or retaining datasets after the run completes.
            const replayTargetCache = new Map<
                string,
                Awaited<ReturnType<typeof loadServerBatchDataset>>
            >();
            const coordinator = this;
            const targetLoader = (targets: readonly typeof eligibleTargets[number][]) => () => (async function* () {
                for (let i = 0; i < targets.length; i++) {
                    const { asset, symbol } = targets[i]!;
                    let data = replayTargetCache.get(symbol);
                    if (data === undefined) {
                        const targetLoadStartedAt = performance.now();
                        try {
                            data = await loadServerBatchDataset(symbol, requestInterval);
                        } finally {
                            const completedAt = performance.now();
                            targetPerformance.replay.targetLoadMs += completedAt - targetLoadStartedAt;
                        }
                        replayTargetCache.set(symbol, data);
                        const lastBar = data[data.length - 1];
                        const timeSec = lastBar ? timeToNumber(lastBar.time) : null;
                        if (timeSec !== null && (coordinator.latestTargetBarTimeSec === null || timeSec > coordinator.latestTargetBarTimeSec)) {
                            coordinator.latestTargetBarTimeSec = timeSec;
                        }
                    }
                    targetPerformance.replay.targetDatasets += 1;
                    yield { asset, symbol, data };
                }
            })();

            const slippageBps = Number(this._request.backtestSettings?.slippageBps) || 0;
            const commissionPct = Number(this._request.capitalSettings?.commission) || 0;
            const slippageRate = slippageBps / 10000;
            const commissionRate = commissionPct / 100;
            this.replayCosts = {
                slippageRate,
                commissionRate,
                slippageBps: Number.isFinite(Number(this.resolvedBacktestSettings?.slippageBps))
                    ? Number(this.resolvedBacktestSettings?.slippageBps)
                    : slippageBps,
                commissionPercent: Number.isFinite(Number(this.resolvedCapitalSettings?.commission))
                    ? Number(this.resolvedCapitalSettings?.commission)
                    : commissionPct,
            };

            let replayPassIndex = 0;
            const runReplayForWindow = (
                sampleFromSec: number | undefined,
                sampleToSec: number | undefined,
            ): Promise<OpenScoreUsdReplayResult> => {
                const includePhase0bDiagnostics = replayPassIndex === 0 && phase0bWriter !== null && !phase0bWriterFailed;
                const targets = orderTopMeanReplayTargets(eligibleTargets, replayPassIndex);
                replayPassIndex += 1;
                return runOpenScoreUsdReplay(
                    () => iterateRunCompactArtifacts(this._request.runId, this.baseDir) as unknown as AsyncIterable<BatchSyntheticPairArtifact>,
                    targetLoader(targets),
                    {
                        horizons: this._request.horizons && this._request.horizons.length > 0 ? this._request.horizons : [12, 24, 48],
                        interval: this._request.interval,
                        slippageRate,
                        commissionRate,
                        includeEventDetails: true,
                        ...(includePhase0bDiagnostics
                            ? {
                                includePoolSnapshots: true,
                                includeCandidateOutcomes: true,
                                catalogAssets: this.canonicalAssets,
                                poolVersion: this.matchedPoolVersion,
                                onPoolSnapshot: async (row) => {
                                    if (phase0bWriterFailed) return;
                                    try {
                                        await phase0bWriter?.onPoolSnapshot(row);
                                    } catch (error) {
                                        debugLogger.warn("sp500_top_mean.phase0b_writer_failed", {
                                            runId: this._request.runId,
                                            error: error instanceof Error ? error.message : String(error),
                                        });
                                        phase0bWriterError ??= error instanceof Error ? error.message : String(error);
                                        phase0bWriterFailed = true;
                                    }
                                },
                                onCandidateOutcome: async (row) => {
                                    if (phase0bWriterFailed) return;
                                    try {
                                        await phase0bWriter?.onCandidateOutcome(row);
                                    } catch (error) {
                                        debugLogger.warn("sp500_top_mean.phase0b_writer_failed", {
                                            runId: this._request.runId,
                                            error: error instanceof Error ? error.message : String(error),
                                        });
                                        phase0bWriterError ??= error instanceof Error ? error.message : String(error);
                                        phase0bWriterFailed = true;
                                    }
                                },
                            }
                            : {}),
                        shouldStop: () => this.isStopped,
                        onPhase: (phase) => {
                            if (phase === activeReplayPhase) return;
                            finishActiveReplayPhase();
                            activeReplayPhase = phase;
                            activeReplayPhaseStartedAt = performance.now();
                        },
                        ...(sampleFromSec !== undefined ? { sampleFromSec } : {}),
                        ...(sampleToSec !== undefined ? { sampleToSec } : {}),
                    },
                );
            };

            const replayResult = await runReplayForWindow(
                this._request.sampleFromSec,
                this._request.sampleToSec,
            );
            finishActiveReplayPhase();
            if (phase0bWriter && !phase0bWriterFailed) {
                try {
                    await phase0bWriter.close();
                    phase0bFiles = phase0bWriter.files;
                } catch (error) {
                    phase0bWriterFailed = true;
                    debugLogger.warn("sp500_top_mean.phase0b_writer_failed", {
                        runId: this._request.runId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    phase0bWriterError ??= error instanceof Error ? error.message : String(error);
                }
            }

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            const buildHorizonSummaries = (result: OpenScoreUsdReplayResult): TopMeanHorizonSummary[] =>
                result.horizons.map((h) => {
                    const topAssets = (h.topMeanByAsset || []).sort((a, b) => {
                        if (b.events !== a.events) return b.events - a.events;
                        return a.asset.localeCompare(b.asset);
                    });

                    return {
                        horizon: h.bars,
                        events: h.topMean.events,
                        topMean: h.topMean,
                        topAssets,
                    };
                });

            const annualReports: TopMeanAnnualReplaySummary[] = [];
            const annualWindows = buildTopMeanAnnualReplayWindows(
                this._request.sampleFromSec,
                this._request.sampleToSec,
            );
            for (let index = 0; index < annualWindows.length; index += 1) {
                const window = annualWindows[index]!;
                this.progressText = `Running OPEN_SCORE USD replay for ${window.year} (${index + 1}/${annualWindows.length})...`;
                emitNdjson({ type: "progress", phase: "replay", text: this.progressText });
                const annualResult = await runReplayForWindow(window.sampleFromSec, window.sampleToSec);
                finishActiveReplayPhase();
                if (this.isStopped) {
                    this.emitInterrupted(emitNdjson);
                    return;
                }
                annualReports.push({
                    ...window,
                    horizons: buildHorizonSummaries(annualResult),
                    eventDetails: annualResult.eventDetails,
                    warnings: annualResult.warnings,
                    reportLines: annualResult.reportLines,
                });
            }
            this.performanceDiagnostic.phases.replayMs = performance.now() - replayStartedAt;

            // Save replay output json. Merges the historical replay fields
            // into the same result.json that already carries the snapshot
            // (written in step 2b). Existing replayResult fields are
            // preserved verbatim (spread first); currentSnapshot is re-stated
            // so the file stays internally consistent after the overwrite.
            this.performanceDiagnostic.completedPairs = manifest.completedPairsCount;
            this.performanceDiagnostic.failedPairs = manifest.failedPairsCount;
            this.performanceDiagnostic.completedAt = new Date().toISOString();
            this.performanceDiagnostic.totalMs = performance.now() - this.performanceStartedAtMs;
            const finalWriteStartedAt = performance.now();
            atomicWriteJsonSync(resultJsonPath, {
                ...replayResult,
                annualReports,
                currentSnapshot: currentSnapshotResult,
                performance: this.performanceSnapshot(),
            });
            this.performanceDiagnostic.phases.resultWriteMs += performance.now() - finalWriteStartedAt;
            this.performanceDiagnostic.completedAt = new Date().toISOString();
            this.performanceDiagnostic.totalMs = performance.now() - this.performanceStartedAtMs;
            const performanceLines = formatTopMeanPerformanceLines(this.performanceDiagnostic);

            // Build result summary
            const horizonSummaries = buildHorizonSummaries(replayResult);
            const annualReportLines = annualReports.flatMap((annual) => [
                "",
                `================ OPEN_SCORE USD | CALENDAR YEAR ${annual.year} ================`,
                ...annual.reportLines,
            ]);

            this.resultSummary = {
                runId: this._request.runId,
                completed: true,
                archiveComplete: false,
                counts: this.counts,
                horizons: horizonSummaries,
                annualReports,
                openScoreEventDetails: replayResult.eventDetails,
                ongoingEventDetails: replayResult.ongoingEventDetails,
                poolSnapshots: replayResult.poolSnapshots,
                candidateOutcomes: replayResult.candidateOutcomes,
                warnings: replayResult.warnings,
                reportLines: [...replayResult.reportLines, ...annualReportLines, "", ...performanceLines],
                latestSelections: replayResult.latestSelections,
                performance: this.performanceDiagnostic,
                currentSnapshot: currentSnapshotResult,
            };

            let archiveOutcome: TopMeanArchiveOutcome;
            if (phase0bWriterFailed) {
                archiveOutcome = {
                    reason: "failed",
                    error: phase0bWriterError ?? "Phase 0b archive staging failed.",
                };
            } else if (!this.archiveRequested) {
                archiveOutcome = { reason: "not_requested" };
            } else if (this.archiveRoot === null) {
                archiveOutcome = { reason: "disabled" };
            } else {
                try {
                    archiveOutcome = await archiveCompletedTopMeanRun(this.resultSummary, this._request, {
                        root: this.baseDir,
                        archiveRoot: this.archiveRoot,
                        canonicalAssets: this.canonicalAssets,
                        fingerprint: this.runFingerprint ?? this.manifest?.fingerprint,
                        warn: (event, data) => debugLogger.warn(event, data),
                        manifest: await this.buildArchiveManifest(),
                        ...(phase0bFiles ? { phase0bFiles } : {}),
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    debugLogger.warn("sp500_top_mean.archive_log_failed", {
                        runId: this._request.runId,
                        error: message,
                    });
                    archiveOutcome = { reason: "failed", error: message };
                }
            }
            this.resultSummary.archiveRequested = this.archiveRequested;
            this.resultSummary.archiveComplete = archiveOutcome.reason === "saved";
            if (archiveOutcome.reason === "saved") {
                this.resultSummary.archiveDir = archiveOutcome.archiveDir;
            } else if (archiveOutcome.reason === "failed") {
                this.resultSummary.archiveError = archiveOutcome.error;
            }

            this.currentPhase = "completed";
            this.progressText = "TOP_MEAN analysis completed successfully.";
            if (this.manifest) {
                this.manifest.status = "completed";
                this.manifest.archiveComplete = this.resultSummary.archiveComplete;
                this.manifest.archiveRequested = this.resultSummary.archiveRequested;
                if (this.resultSummary.archiveDir !== undefined) {
                    this.manifest.archiveDir = this.resultSummary.archiveDir;
                }
                if (this.resultSummary.archiveError !== undefined) {
                    this.manifest.archiveError = this.resultSummary.archiveError;
                }
                this.updateManifestEngineTelemetry(this.manifest);
                this.manifest.updatedAt = Date.now();
                saveManifest(this.manifest, this.baseDir);
            }

            emitNdjson({
                type: "done",
                result: this.resultSummary,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (this.isStopped || message.toLowerCase().includes("cancelled") || message.toLowerCase().includes("interrupted")) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            this.currentPhase = "failed";
            this.progressText = `Fatal error: ${message}`;
            if (this.performanceDiagnostic) {
                this.performanceDiagnostic.completedAt = new Date().toISOString();
                this.performanceDiagnostic.totalMs = performance.now() - this.performanceStartedAtMs;
            }
            if (this.manifest) {
                this.manifest.status = "failed";
                this.manifest.error = message;
                this.updateManifestEngineTelemetry(this.manifest);
                this.manifest.updatedAt = Date.now();
                saveManifest(this.manifest, this.baseDir);
            }
            // The current snapshot (if computed before the failure) survives
            // the replay failure: it is already on disk (step 2b) and is
            // attached to the fatal event so the UI can render it. The
            // historical replay fields are simply absent.
            emitNdjson({
                type: "fatal",
                error: message,
                ...(this.performanceDiagnostic ? { performance: this.performanceSnapshot() } : {}),
                ...(this.currentSnapshotResult ? { currentSnapshot: this.currentSnapshotResult } : {}),
            });
        } finally {
            if (phase0bWriter) {
                await phase0bWriter.dispose().catch(() => undefined);
            }
            if (activeEngineInstance === this) {
                activeEngineInstance = null;
            }
        }
    }

    private emitInterrupted(emitNdjson: (event: unknown) => void): void {
        this.currentPhase = "interrupted";
        this.progressText = "Run stopped by user.";
        if (this.performanceDiagnostic) {
            this.performanceDiagnostic.completedAt = new Date().toISOString();
            this.performanceDiagnostic.totalMs = performance.now() - this.performanceStartedAtMs;
        }
        if (this.manifest) {
            this.manifest.status = "interrupted";
            this.updateManifestEngineTelemetry(this.manifest);
            this.manifest.updatedAt = Date.now();
            saveManifest(this.manifest, this.baseDir);
        }
        emitNdjson({
            type: "done",
            interrupted: true,
            ...(this.performanceDiagnostic ? { performance: this.performanceSnapshot() } : {}),
        });
    }
}
