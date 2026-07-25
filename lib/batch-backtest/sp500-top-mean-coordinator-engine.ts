import { join } from "node:path";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
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
import { TopMeanWorkerPool, resolveTopMeanWorkerCount } from "./sp500-top-mean-worker-pool";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdReplayResult,
    type AssetSelectionSummary,
    type ReplayComparison,
} from "./batch-open-score-usd-replay-engine";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import { markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import {
    computeCurrentTopMeanSnapshot,
    type CurrentTopMeanResult,
} from "./sp500-top-mean-current-snapshot";
import {
    compareStabilitySnapshots,
    formatStartDateLabel,
    type StabilityComparison,
    type StabilityWindowResult,
} from "./sp500-top-mean-stability-compare";

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
    useRustEnginePreference?: boolean;
    /**
     * Optional decision-event date window (unix seconds, inclusive) applied
     * ONLY to the phase-3 OPEN_SCORE USD replay. Pair backtests (phase 2)
     * always cover full history. Mirrors the OPEN_SCORE USD sampleFromSec /
     * sampleToSec semantics; undefined = full history.
     */
    sampleFromSec?: number;
    sampleToSec?: number;
    /**
     * Stability mode: when this is a non-empty array, the engine runs the
     * current snapshot across each of these start dates (plus an implicit
     * full-history window) and emits a terminal `stability_done` event with
     * the comparison. Each entry is a unix-second simulation start date. The
     * historical replay phase is SKIPPED in stability mode. When undefined
     * (or empty), the engine runs the normal single-snapshot + replay path.
     */
    stabilityStartDates?: number[];
}

export interface TopMeanResultSummary {
    runId: string;
    completed: boolean;
    counts: CoverageCounts;
    horizons: Array<{
        horizon: number;
        events: number;
        topMean: ReplayComparison;
        topAssets: AssetSelectionSummary[];
    }>;
    warnings: string[];
    reportLines: string[];
    /**
     * Phase-1 current snapshot: TOP_MEAN derived from positions open at the
     * latest common closed candle, computed from compact artifacts. Separate
     * from `horizons` (the historical OPEN_SCORE replay leaderboard).
     * Optional for backward compatibility with older payloads.
     */
    currentSnapshot?: CurrentTopMeanResult;
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
    error?: string;
    result?: TopMeanResultSummary;
    /**
     * Stability-mode progress (only present mid-run in stability mode). Lets
     * the /status reattach path show which window is running and what has
     * completed so far. Absent in the normal single-snapshot path.
     */
    stabilityProgress?: {
        currentWindow: number;
        totalWindows: number;
        completedWindows: StabilityWindowResult[];
    };
    /**
     * Terminal stability comparison (only present after a stability run
     * completes). Absent in the normal path and during a run.
     */
    stabilityResult?: StabilityComparison;
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
    /**
     * Stability-mode state: the per-window results accumulated so far, the
     * total window count, and the terminal comparison. Null/empty in the
     * normal single-snapshot path.
     */
    private stabilityCompletedWindows: StabilityWindowResult[] = [];
    private stabilityTotalWindows = 0;
    private stabilityCurrentWindow = 0;
    private stabilityResult: StabilityComparison | null = null;
    /** Aggregated actual engine usage across completed pair backtests. */
    private engineUsage: { rust: number; typescript: number } = { rust: 0, typescript: 0 };

    constructor(
        private readonly _request: TopMeanCoordinatorRunRequest,
        private readonly baseDir?: string,
    ) {}

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
            error: this.manifest?.error,
            result: this.resultSummary || undefined,
            ...(this.stabilityTotalWindows > 0 && !this.stabilityResult
                ? {
                    stabilityProgress: {
                        currentWindow: this.stabilityCurrentWindow,
                        totalWindows: this.stabilityTotalWindows,
                        completedWindows: this.stabilityCompletedWindows,
                    },
                }
                : {}),
            ...(this.stabilityResult ? { stabilityResult: this.stabilityResult } : {}),
        };
    }

    private resolveActualEngineMode(): string {
        return this.resolveEngineMode(this.engineUsage);
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
    }

    private updateManifestEngineTelemetry(manifest: TopMeanRunManifest): void {
        manifest.requestedEngineMode = this._request.useRustEnginePreference ? "rust" : "typescript";
        manifest.actualEngineMode = this.resolveActualEngineMode();
        manifest.engineUsage = { ...this.engineUsage };
        manifest.workerCount = resolveTopMeanWorkerCount(this._request.workerCount);
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
        activeEngineInstance = this;
        reconcileInterruptedManifestsOnStartup(this.baseDir);
        cleanOldArtifacts(this.baseDir);

        try {
            // 1. Enumeration & Preflight
            this.currentPhase = "preflight";
            this.progressText = "Enumerating S&P 500 assets and pairs...";
            const enumRes = enumerateSp500Pairs({
                interval: this._request.interval,
                maxPairs: this._request.maxPairs,
                pairListText: this._request.pairListText,
                baseDir: this.baseDir,
            });

            this.counts = enumRes.counts;
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
                    shardSize: 50,
                    totalShards: Math.ceil(enumRes.canonicalPairs.length / 50),
                    completedShards: [],
                    failedShards: [],
                    completedPairsCount: 0,
                    failedPairsCount: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            }
            this.manifest = manifest;
            this.engineUsage = {
                rust: manifest.engineUsage?.rust ?? 0,
                typescript: manifest.engineUsage?.typescript ?? 0,
            };
            this.updateManifestEngineTelemetry(manifest);
            saveManifest(manifest, this.baseDir);

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // Stability mode: run the current snapshot across N start dates
            // and emit a terminal comparison. Skips the worker+snapshot+replay
            // single-run path entirely. Branches here so the normal path below
            // is unchanged when stabilityStartDates is absent/empty.
            const stabilityDates = this._request.stabilityStartDates;
            if (stabilityDates && stabilityDates.length > 0) {
                await this.runStabilityMode(emitNdjson, enumRes, fingerprint);
                return;
            }

            // 2. Worker Execution Phase
            this.currentPhase = "backtesting";
            this.progressText = `Running backtests across ${enumRes.canonicalPairs.length} pairs...`;

            this.pool = new TopMeanWorkerPool();

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

            const currentSnapshotResult = await computeCurrentTopMeanSnapshot(
                () => iterateRunRawCompactArtifacts(this._request.runId, this.baseDir),
                { shouldStop: () => this.isStopped },
            );
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
            atomicWriteJsonSync(resultJsonPath, { currentSnapshot: currentSnapshotResult });
            emitNdjson({ type: "current_snapshot", currentSnapshot: currentSnapshotResult });

            // 3. Replay & Asset Selector Study Phase
            this.progressText = "Running OPEN_SCORE USD replay and asset selection analysis...";
            emitNdjson({ type: "progress", phase: "replay", text: this.progressText });

            const eligibleAssets = enumRes.eligibleAssets;
            const requestInterval = this._request.interval;

            const targetLoader = () => (async function* () {
                for (let i = 0; i < eligibleAssets.length; i++) {
                    const asset = stripIbkrMarker(eligibleAssets[i]);
                    const marked = markIbkrSymbol(asset);
                    const candles = await loadServerBatchDataset(marked, requestInterval);
                    yield {
                        asset,
                        symbol: marked,
                        data: candles,
                    };
                }
            })();

            const slippageBps = Number(this._request.backtestSettings?.slippageBps) || 0;
            const commissionPct = Number(this._request.capitalSettings?.commission) || 0;
            const slippageRate = slippageBps / 10000;
            const commissionRate = commissionPct / 100;

            const replayResult: OpenScoreUsdReplayResult = await runOpenScoreUsdReplay(
                () => iterateRunCompactArtifacts(this._request.runId, this.baseDir) as unknown as AsyncIterable<BatchSyntheticPairArtifact>,
                targetLoader,
                {
                    horizons: this._request.horizons && this._request.horizons.length > 0 ? this._request.horizons : [12, 24, 48],
                    interval: this._request.interval,
                    slippageRate,
                    commissionRate,
                    shouldStop: () => this.isStopped,
                    ...(this._request.sampleFromSec !== undefined ? { sampleFromSec: this._request.sampleFromSec } : {}),
                    ...(this._request.sampleToSec !== undefined ? { sampleToSec: this._request.sampleToSec } : {}),
                },
            );

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // Save replay output json. Merges the historical replay fields
            // into the same result.json that already carries the snapshot
            // (written in step 2b). Existing replayResult fields are
            // preserved verbatim (spread first); currentSnapshot is re-stated
            // so the file stays internally consistent after the overwrite.
            atomicWriteJsonSync(resultJsonPath, { ...replayResult, currentSnapshot: currentSnapshotResult });

            // Build result summary
            const horizonSummaries = replayResult.horizons.map((h) => {
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

            this.resultSummary = {
                runId: this._request.runId,
                completed: true,
                counts: this.counts,
                horizons: horizonSummaries,
                warnings: replayResult.warnings,
                reportLines: replayResult.reportLines,
                currentSnapshot: currentSnapshotResult,
            };

            this.currentPhase = "completed";
            this.progressText = "S&P 500 TOP_MEAN analysis completed successfully.";
            if (this.manifest) {
                this.manifest.status = "completed";
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
                ...(this.currentSnapshotResult ? { currentSnapshot: this.currentSnapshotResult } : {}),
            });
        } finally {
            if (activeEngineInstance === this) {
                activeEngineInstance = null;
            }
        }
    }

    /**
     * Stability mode: run the current snapshot across N start-date windows
     * (plus an implicit full-history window) and emit a terminal comparison.
     *
     * Each window gets its own window-scoped artifact subdir so concurrent
     * windows cannot overwrite each other. Windows run SEQUENTIALLY inside
     * this one owner-lock acquisition (the global mutex forbids parallel
     * coordinator runs by design). The historical replay phase is skipped —
     * it is irrelevant to the stability question and would multiply cost.
     *
     * The owner-lock is held by the caller (`run()`); this method does not
     * touch it. Cancellation is honored between windows and mid-worker via
     * the existing `isStopped` / `pool.cancel()` seam.
     */
    private async runStabilityMode(
        emitNdjson: (event: unknown) => void,
        enumRes: ReturnType<typeof enumerateSp500Pairs>,
        fingerprint: string,
    ): Promise<void> {
        // Build the window list: full-history first, then each user start date.
        // Deduplicate by startDateSec so a user listing "full" twice (or
        // repeated dates) does not double-count.
        const requested = this._request.stabilityStartDates ?? [];
        const windowDefs: Array<{ startDateSec: number | null; label: string; windowKey: string }> = [];
        const seenKeys = new Set<string>();
        const pushWindow = (startDateSec: number | null): void => {
            const windowKey = startDateSec === null ? "full" : `from_${startDateSec}`;
            if (seenKeys.has(windowKey)) return;
            seenKeys.add(windowKey);
            windowDefs.push({ startDateSec, label: formatStartDateLabel(startDateSec), windowKey });
        };
        pushWindow(null); // implicit full-history window
        for (const d of requested) pushWindow(d);

        this.stabilityTotalWindows = windowDefs.length;
        this.stabilityCurrentWindow = 0;
        this.stabilityCompletedWindows = [];

        this.currentPhase = "backtesting";
        emitNdjson({
            type: "progress",
            phase: "stability",
            text: `Stability mode: ${windowDefs.length} windows (full + ${requested.length} start date${requested.length === 1 ? "" : "s"})`,
            totalWindows: windowDefs.length,
            currentWindow: 0,
        });

        for (let i = 0; i < windowDefs.length; i++) {
            const w = windowDefs[i]!;
            this.stabilityCurrentWindow = i + 1;
            this.progressText = `Stability window ${i + 1}/${windowDefs.length}: ${w.label}`;
            emitNdjson({
                type: "progress",
                phase: "stability",
                text: this.progressText,
                totalWindows: windowDefs.length,
                currentWindow: i + 1,
                windowLabel: w.label,
            });

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // Per-window manifest in the window-scoped subdir. Resume is
            // supported per-window: a reattach picks up where it left off if
            // the manifest already exists with matching fingerprint.
            let windowManifest = loadManifest(this._request.runId, this.baseDir, w.windowKey);
            if (windowManifest) {
                if (windowManifest.fingerprint !== fingerprint) {
                    throw new Error(`Stability window ${w.label} fingerprint mismatch: run settings or universe changed.`);
                }
                windowManifest.status = "running";
            } else {
                windowManifest = {
                    schema: "top_mean_run_manifest.v1",
                    runId: this._request.runId,
                    status: "running",
                    fingerprint,
                    strategyKey: this._request.strategyKey,
                    interval: this._request.interval,
                    pairCount: enumRes.canonicalPairs.length,
                    shardSize: 50,
                    totalShards: Math.ceil(enumRes.canonicalPairs.length / 50),
                    completedShards: [],
                    failedShards: [],
                    completedPairsCount: 0,
                    failedPairsCount: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
            }
            const priorWindowUsage = {
                rust: windowManifest.engineUsage?.rust ?? 0,
                typescript: windowManifest.engineUsage?.typescript ?? 0,
            };
            windowManifest.requestedEngineMode = this._request.useRustEnginePreference ? "rust" : "typescript";
            windowManifest.workerCount = resolveTopMeanWorkerCount(this._request.workerCount);
            saveManifest(windowManifest, this.baseDir, w.windowKey);

            this.pool = new TopMeanWorkerPool();
            const usage = await this.pool.execute({
                runId: this._request.runId,
                manifest: windowManifest,
                canonicalPairs: enumRes.canonicalPairs,
                strategyKey: this._request.strategyKey,
                strategyParams: this._request.strategyParams,
                backtestSettings: this._request.backtestSettings,
                capitalSettings: this._request.capitalSettings,
                interval: this._request.interval,
                workerCount: this._request.workerCount,
                useRustEnginePreference: this._request.useRustEnginePreference,
                baseDir: this.baseDir,
                ...(w.startDateSec !== null ? { backtestFromSec: w.startDateSec } : {}),
                windowKey: w.windowKey,
                onProgress: (completed, total, text) => {
                    this.progressText = `[${w.label}] ${text}`;
                    emitNdjson({
                        type: "progress",
                        phase: "backtesting",
                        windowLabel: w.label,
                        windowIndex: i,
                        totalWindows: windowDefs.length,
                        completed,
                        total,
                        text: this.progressText,
                    });
                },
            });
            this.absorbEngineUsage(usage);
            windowManifest.engineUsage = {
                rust: priorWindowUsage.rust + usage.rust,
                typescript: priorWindowUsage.typescript + usage.typescript,
            };
            windowManifest.actualEngineMode = this.resolveEngineMode(windowManifest.engineUsage);
            saveManifest(windowManifest, this.baseDir, w.windowKey);

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // Snapshot for this window from its window-scoped artifacts.
            const snapshotResult = await computeCurrentTopMeanSnapshot(
                () => iterateRunRawCompactArtifacts(this._request.runId, this.baseDir, w.windowKey),
                { shouldStop: () => this.isStopped },
            );

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            const windowResult: StabilityWindowResult = {
                startDateSec: w.startDateSec,
                label: w.label,
                snapshot: snapshotResult.snapshot,
                stats: snapshotResult.stats,
            };
            this.stabilityCompletedWindows.push(windowResult);
            windowManifest.status = "completed";
            windowManifest.updatedAt = Date.now();
            saveManifest(windowManifest, this.baseDir, w.windowKey);

            emitNdjson({
                type: "current_snapshot",
                currentSnapshot: snapshotResult,
                windowLabel: w.label,
                windowIndex: i,
                totalWindows: windowDefs.length,
            });
        }

        // All windows complete: compute the comparison and emit the terminal
        // stability_done event. This is the Phase-2 gate verdict.
        const comparison = compareStabilitySnapshots(this.stabilityCompletedWindows);
        this.stabilityResult = comparison;

        // Persist the comparison so the /status reattach path can return it
        // after the engine instance is gone (browser reload post-completion).
        // Mirrors how the single-snapshot path persists to result.json.
        const stabilityResultPath = join(getRunDir(this._request.runId, this.baseDir), "stability_result.json");
        atomicWriteJsonSync(stabilityResultPath, comparison);

        this.currentPhase = "completed";
        this.progressText = `Stability check complete: gate ${comparison.parityAssumptionHolds ? "PASS" : "BLOCKED"} (agreement ${comparison.agreementPct.toFixed(1)}%)`;
        if (this.manifest) {
            this.manifest.status = "completed";
            this.updateManifestEngineTelemetry(this.manifest);
            this.manifest.updatedAt = Date.now();
            saveManifest(this.manifest, this.baseDir);
        }

        emitNdjson({
            type: "stability_done",
            comparison,
        });
    }

    private emitInterrupted(emitNdjson: (event: unknown) => void): void {
        this.currentPhase = "interrupted";
        this.progressText = "Run stopped by user.";
        if (this.manifest) {
            this.manifest.status = "interrupted";
            this.updateManifestEngineTelemetry(this.manifest);
            this.manifest.updatedAt = Date.now();
            saveManifest(this.manifest, this.baseDir);
        }
        emitNdjson({
            type: "done",
            interrupted: true,
        });
    }
}
