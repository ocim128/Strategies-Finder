import { join } from "node:path";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { enumerateSp500Pairs, type CoverageCounts } from "./sp500-pair-enumerator";
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
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { TopMeanWorkerPool, resolveTopMeanWorkerCount } from "./sp500-top-mean-worker-pool";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdReplayResult,
    type AssetSelectionSummary,
    type ReplayComparison,
} from "./batch-open-score-usd-replay-engine";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import { markIbkrSymbol } from "../local-daily-datasets";

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

    constructor(public readonly request: TopMeanCoordinatorRunRequest, private baseDir?: string) {}

    public getStatus(): TopMeanStatusResponse {
        return {
            runId: this.request.runId,
            status: this.manifest?.status || (this.isStopped ? "interrupted" : "running"),
            phase: this.currentPhase,
            fingerprint: this.manifest?.fingerprint,
            counts: this.counts || undefined,
            pairTotals: this.counts?.pairCount || 0,
            completedPairs: this.manifest?.completedPairsCount || 0,
            failedPairs: this.manifest?.failedPairsCount || 0,
            progressText: this.progressText,
            workerCount: resolveTopMeanWorkerCount(this.request.workerCount),
            actualEngineMode: this.request.useRustEnginePreference ? "rust" : "typescript",
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
        this.currentPhase = "interrupted" as any;
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
                interval: this.request.interval,
                maxPairs: this.request.maxPairs,
                baseDir: this.baseDir,
            });

            this.counts = enumRes.counts;
            emitNdjson({ type: "preflight", counts: this.counts });

            if (enumRes.canonicalPairs.length === 0) {
                throw new Error("No canonical pairs available for evaluation.");
            }

            const fingerprint = computeRunFingerprint({
                strategyKey: this.request.strategyKey,
                strategyParams: this.request.strategyParams,
                backtestSettings: this.request.backtestSettings,
                capitalSettings: this.request.capitalSettings,
                interval: this.request.interval,
                useRustEnginePreference: this.request.useRustEnginePreference,
                canonicalAssets: enumRes.eligibleAssets,
            });

            let manifest = loadManifest(this.request.runId, this.baseDir);

            if (this.request.resume && manifest) {
                if (manifest.fingerprint !== fingerprint) {
                    throw new Error("Resume fingerprint mismatch: run settings or universe changed.");
                }
                manifest.status = "running";
            } else {
                manifest = {
                    schema: "top_mean_run_manifest.v1",
                    runId: this.request.runId,
                    status: "running",
                    fingerprint,
                    strategyKey: this.request.strategyKey,
                    interval: this.request.interval,
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

            // 2. Backtesting Phase (Worker Pool)
            this.currentPhase = "backtesting";
            if (this.isStopped) return;

            this.pool = new TopMeanWorkerPool();

            await this.pool.execute({
                runId: this.request.runId,
                manifest: this.manifest,
                canonicalPairs: enumRes.canonicalPairs,
                strategyKey: this.request.strategyKey,
                strategyParams: this.request.strategyParams,
                backtestSettings: this.request.backtestSettings,
                capitalSettings: this.request.capitalSettings,
                interval: this.request.interval,
                workerCount: this.request.workerCount,
                useRustEnginePreference: this.request.useRustEnginePreference,
                baseDir: this.baseDir,
                onProgress: (completed, total, text) => {
                    this.progressText = text;
                    emitNdjson({
                        type: "progress",
                        phase: "backtesting",
                        completed,
                        total,
                        text,
                    });
                },
            });

            if (this.isStopped) return;

            // 3. Replay Phase
            this.currentPhase = "replay";
            this.progressText = "Streaming target assets for OPEN_SCORE USD replay...";
            emitNdjson({
                type: "progress",
                phase: "replay",
                completed: 0,
                total: 100,
                text: this.progressText,
            });

            const runId = this.request.runId;
            const baseDir = this.baseDir;
            const eligibleAssets = enumRes.eligibleAssets;
            const requestInterval = this.request.interval;
            const checkStopped = () => this.isStopped;

            const artifactLoader = () => iterateRunCompactArtifacts(runId, baseDir) as any;
            const targetLoader = () => (async function* () {
                for (let i = 0; i < eligibleAssets.length; i++) {
                    if (checkStopped()) break;
                    const marked = markIbkrSymbol(eligibleAssets[i]);
                    const candles = await loadServerBatchDataset(marked, requestInterval);
                    yield {
                        asset: marked,
                        symbol: marked,
                        data: candles,
                    };
                }
            })();

            const slippageBps = Number(this.request.backtestSettings?.slippageBps) || 0;
            const commissionPct = Number(this.request.capitalSettings?.commission) || 0;
            const slippageRate = slippageBps / 10000;
            const commissionRate = commissionPct / 100;

            const replayResult: OpenScoreUsdReplayResult = await runOpenScoreUsdReplay(
                artifactLoader,
                targetLoader,
                {
                    horizons: this.request.horizons && this.request.horizons.length > 0 ? this.request.horizons : [12, 24, 48],
                    interval: this.request.interval,
                    slippageRate,
                    commissionRate,
                    shouldStop: () => this.isStopped,
                },
            );

            if (this.isStopped) return;

            // Save replay output json
            const resultJsonPath = join(getRunDir(this.request.runId, this.baseDir), "result.json");
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
                runId: this.request.runId,
                completed: replayResult.complete,
                counts: this.counts,
                horizons: horizonSummaries,
                warnings: replayResult.warnings || [],
                reportLines: replayResult.reportLines || [],
            };

            this.manifest.status = "completed";
            saveManifest(this.manifest, this.baseDir);

            this.currentPhase = "completed";
            this.progressText = "TOP_MEAN run completed successfully.";

            emitNdjson({
                type: "done",
                runId: this.request.runId,
                result: this.resultSummary,
            });
        } catch (err) {
            const errorText = err instanceof Error ? err.message : String(err);
            if (this.isStopped || errorText.includes("cancelled") || errorText.includes("Operation cancelled")) {
                this.currentPhase = "interrupted";
                this.progressText = "Stopped by user";
                if (this.manifest) {
                    this.manifest.status = "interrupted";
                    saveManifest(this.manifest, this.baseDir);
                }
            } else {
                this.currentPhase = "failed";
                this.progressText = `Fatal error: ${errorText}`;

                if (this.manifest) {
                    this.manifest.status = "failed";
                    this.manifest.error = errorText;
                    saveManifest(this.manifest, this.baseDir);
                }

                emitNdjson({
                    type: "fatal",
                    runId: this.request.runId,
                    error: errorText,
                });
            }
        } finally {
            activeEngineInstance = null;
        }
    }
}
