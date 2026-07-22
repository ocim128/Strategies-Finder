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
    actualEngineMode: string;
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
            actualEngineMode: this._request.useRustEnginePreference ? "rust" : "typescript",
            error: this.manifest?.error,
            result: this.resultSummary || undefined,
        };
    }

    public stop(): void {
        this.isStopped = true;
        if (this.pool) {
            this.pool.cancel();
        }
        if (this.manifest) {
            this.manifest.status = "interrupted";
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
            saveManifest(manifest, this.baseDir);

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // 2. Worker Execution Phase
            this.currentPhase = "backtesting";
            this.progressText = `Running backtests across ${enumRes.canonicalPairs.length} pairs...`;

            this.pool = new TopMeanWorkerPool();

            await this.pool.execute({
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

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // 3. Replay & Asset Selector Study Phase
            this.currentPhase = "replay";
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
                },
            );

            if (this.isStopped) {
                this.emitInterrupted(emitNdjson);
                return;
            }

            // Save replay output json
            const resultJsonPath = join(getRunDir(this._request.runId, this.baseDir), "result.json");
            atomicWriteJsonSync(resultJsonPath, replayResult);

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
            };

            this.currentPhase = "completed";
            this.progressText = "S&P 500 TOP_MEAN analysis completed successfully.";
            if (this.manifest) {
                this.manifest.status = "completed";
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
                this.manifest.updatedAt = Date.now();
                saveManifest(this.manifest, this.baseDir);
            }
            emitNdjson({
                type: "fatal",
                error: message,
            });
        } finally {
            if (activeEngineInstance === this) {
                activeEngineInstance = null;
            }
        }
    }

    private emitInterrupted(emitNdjson: (event: unknown) => void): void {
        this.currentPhase = "interrupted";
        this.progressText = "Run stopped by user.";
        if (this.manifest) {
            this.manifest.status = "interrupted";
            this.manifest.updatedAt = Date.now();
            saveManifest(this.manifest, this.baseDir);
        }
        emitNdjson({
            type: "done",
            interrupted: true,
        });
    }
}
