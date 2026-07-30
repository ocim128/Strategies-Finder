import { parentPort, isMainThread } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { executeBacktest, prepareClosedCandleData, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { getServerBatchDatasetCacheStats, loadServerBatchDataset } from "./server-batch-data-loader";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { canonicalizeLegIdentity } from "../synthetic-leg-identity";
import { stripIbkrMarker } from "../local-daily-datasets";
import { selectClosedCandleWindow } from "../alert-evaluation-window";
import type { CompactPairArtifact, CompactTrade } from "./compact-pair-artifact";
import type { BacktestSettings, OHLCVData, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { strategies } from "../strategies/library";
import type { TopMeanCacheCounters, TopMeanWorkerTiming } from "./sp500-top-mean-performance";

export const TOP_MEAN_BACKTEST_RUN_OPTIONS = Object.freeze({
    includeAdvancedAnalytics: false,
    includeSharpeRatio: false,
    collectExecutorTimings: true,
    useCompactBacktest: false,
    omitEquityCurve: true,
    skipDrawdown: true,
    skipResultPostProcessing: true,
});

export interface TopMeanWorkerTaskData {
    shardIndex: number;
    pairs: Array<{
        pairIndex: number;
        symbol: string;
    }>;
    strategyKey: string;
    strategyParams: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    interval: string;
    useRustEnginePreference?: boolean;
}

export type TopMeanWorkerMessage =
    | {
          type: "progress";
          shardIndex: number;
          pairIndex: number;
          symbol: string;
          status: "completed" | "failed";
          error?: string;
          /** Engine that actually executed the pair backtest (not the preference). */
          engineUsed?: "rust" | "typescript";
      }
    | {
          type: "shard_complete";
          shardIndex: number;
          artifacts: CompactPairArtifact[];
          engineUsage?: { rust: number; typescript: number };
          performance: TopMeanWorkerTiming;
      }
    | {
          type: "error";
          shardIndex: number;
          error: string;
      };

function subtractCacheCounters(
    after: ReturnType<typeof getServerBatchDatasetCacheStats>,
    before: ReturnType<typeof getServerBatchDatasetCacheStats>,
): TopMeanCacheCounters {
    return {
        legHits: after.leg.hits - before.leg.hits,
        legMisses: after.leg.misses - before.leg.misses,
        pairHits: after.pair.hits - before.pair.hits,
        pairMisses: after.pair.misses - before.pair.misses,
        diskHits: after.disk.hits - before.disk.hits,
        diskMisses: after.disk.misses - before.disk.misses,
        diskWrites: after.disk.writes - before.disk.writes,
    };
}

export async function processTopMeanShard(data: TopMeanWorkerTaskData): Promise<{
    artifacts: CompactPairArtifact[];
    engineUsage: { rust: number; typescript: number };
    performance: TopMeanWorkerTiming;
}> {
    const shardStartedAt = performance.now();
    const cacheBefore = getServerBatchDatasetCacheStats();
    const strategy = strategies[data.strategyKey];
    if (!strategy) {
        throw new Error(`Built-in strategy "${data.strategyKey}" not found in manifest.`);
    }

    const preResolvedSettings = resolveExecutorBacktestSettings(data.backtestSettings, data.interval);
    const preResolvedCapital = resolveCapitalSettingsFromRaw(data.capitalSettings as any);
    const nowSec = Math.floor(Date.now() / 1000);

    const artifacts: CompactPairArtifact[] = [];
    let rustCount = 0;
    let typescriptCount = 0;
    const timing: TopMeanWorkerTiming = {
        attemptedPairs: 0,
        completedPairs: 0,
        failedPairs: 0,
        loadMs: 0,
        prepareMs: 0,
        backtestMs: 0,
        signalGenerationMs: 0,
        exitProcessingMs: 0,
        exitStrategyMs: 0,
        exitStrategyLoadMs: 0,
        exitStrategyNormalizeMs: 0,
        exitSignalGenerationMs: 0,
        exitMergeMs: 0,
        exitBookkeepingMs: 0,
        exitOverrideSignals: 0,
        engineMs: 0,
        engineDiagnosticPairs: 0,
        engineDiagnostics: {
            total: 0,
            dataClean: 0,
            indicatorResolution: 0,
            signalPreparation: 0,
            signalIndexing: 0,
            entryEvaluation: 0,
            tradeSimulation: 0,
            forcedClose: 0,
            drawdown: 0,
            metrics: 0,
        },
        artifactMs: 0,
        pairWallMs: 0,
        shardWallMs: 0,
        cache: {
            legHits: 0,
            legMisses: 0,
            pairHits: 0,
            pairMisses: 0,
            diskHits: 0,
            diskMisses: 0,
            diskWrites: 0,
        },
    };

    for (const pair of data.pairs) {
        const pairStartedAt = performance.now();
        timing.attemptedPairs += 1;
        let pairSymbol = pair.symbol;
        const parsed = parsePortfolioSyntheticPairSymbol(pairSymbol);
        const direct = parsed ? null : canonicalizeLegIdentity(pairSymbol);

        const baseAsset = parsed ? parsed.baseAsset : (direct?.scoringAsset ?? stripIbkrMarker(pairSymbol));
        const quoteAsset = parsed ? parsed.quoteAsset : "";
        const baseSymbol = parsed ? parsed.baseSymbol : (direct?.loaderSymbol ?? pairSymbol);
        const quoteSymbol = parsed ? parsed.quoteSymbol : "";

        try {
            const loadStartedAt = performance.now();
            let candles: OHLCVData[];
            try {
                candles = await loadServerBatchDataset(pairSymbol, data.interval);
            } finally {
                timing.loadMs += performance.now() - loadStartedAt;
            }

            if (!candles || candles.length < 200) {
                timing.failedPairs += 1;
                if (parentPort) {
                    parentPort.postMessage({
                        type: "progress",
                        shardIndex: data.shardIndex,
                        pairIndex: pair.pairIndex,
                        symbol: pairSymbol,
                        status: "failed",
                        error: "Insufficient candles or load failure",
                    } as TopMeanWorkerMessage);
                }
                continue;
            }

            // Precompute the exact closed-candle array the engine will consume
            // and pass it through closedCandleDataOverride. This (a) skips the
            // internal selectClosedCandleData call, (b) lets us record the
            // authoritative LAST CLOSED candle timestamp as dataEndTime, and
            // (c) stabilizes the array reference for WeakMap caches per
            // prepareClosedCandleData's contract.
            //
            // dataEndTime is taken from selectClosedCandleWindow's
            // closedCandleTimeSec — NOT from the last element of either the
            // raw array or the prepared array. In next_open execution mode the
            // prepared array is bridged with a synthetic candle at the next
            // bar's OPEN time, so its last element's time is the OPEN bar,
            // not the closed bar. The snapshot asks "as-of which closed
            // candle?", and closedCandleTimeSec is the unambiguous answer
            // regardless of execution model.
            const prepareStartedAt = performance.now();
            const closedCandleData = prepareClosedCandleData(
                candles,
                data.interval,
                data.backtestSettings,
                nowSec,
            );
            const closedWindow = selectClosedCandleWindow(candles, data.interval, nowSec, 1);
            timing.prepareMs += performance.now() - prepareStartedAt;

            const backtestStartedAt = performance.now();
            const collectEngineDiagnostics = timing.engineDiagnosticPairs === 0;
            const output = await executeBacktest({
                ohlcvData: candles,
                closedCandleDataOverride: closedCandleData,
                interval: data.interval,
                primarySymbol: pairSymbol,
                strategyKey: data.strategyKey,
                strategy,
                strategyParams: data.strategyParams,
                backtestSettings: data.backtestSettings,
                capitalSettings: data.capitalSettings,
                preResolvedSettings,
                preResolvedCapital,
                context: {
                    blockRange: null,
                    annotatePolymarket: false,
                    engineMode: "auto",
                    useRustEnginePreference: data.useRustEnginePreference,
                    nowSec,
                },
                backtestRunOptions: collectEngineDiagnostics
                    ? { ...TOP_MEAN_BACKTEST_RUN_OPTIONS, collectDiagnostics: true }
                    : TOP_MEAN_BACKTEST_RUN_OPTIONS,
            });
            timing.backtestMs += performance.now() - backtestStartedAt;
            if (output.executorTimings) {
                timing.signalGenerationMs += output.executorTimings.signalGenerationMs;
                timing.exitProcessingMs += output.executorTimings.exitProcessingMs;
                timing.exitStrategyMs += output.executorTimings.exitStrategyMs;
                timing.exitStrategyLoadMs += output.executorTimings.exitStrategyLoadMs;
                timing.exitStrategyNormalizeMs += output.executorTimings.exitStrategyNormalizeMs;
                timing.exitSignalGenerationMs += output.executorTimings.exitSignalGenerationMs;
                timing.exitMergeMs += output.executorTimings.exitMergeMs;
                timing.exitBookkeepingMs += output.executorTimings.exitBookkeepingMs;
                timing.exitOverrideSignals += output.executorTimings.exitOverrideSignals;
                timing.engineMs += output.executorTimings.engineMs;
            }
            const engineDiagnostics = output.result.diagnostics?.timingsMs;
            if (engineDiagnostics) {
                timing.engineDiagnosticPairs += 1;
                for (const key of Object.keys(engineDiagnostics) as Array<keyof typeof engineDiagnostics>) {
                    timing.engineDiagnostics[key] += engineDiagnostics[key];
                }
            }

            const artifactStartedAt = performance.now();
            const compactTrades: CompactTrade[] = (output.result?.trades || []).map((t) => ({
                type: t.type,
                entryTime: t.entryTime,
                exitTime: t.exitTime,
                exitReason: t.exitReason,
            }));

            // dataEndTime = the authoritative last-closed-candle timestamp
            // (closedCandleTimeSec). Falls back to the prepared array's last
            // element only when selectClosedCandleWindow could not resolve a
            // window (e.g. interval parse failure) — in which case there is no
            // reliable "open vs closed" distinction to make anyway.
            const dataEndTime = closedWindow?.closedCandleTimeSec
                ?? (closedCandleData.length > 0
                    ? Number(closedCandleData[closedCandleData.length - 1]!.time)
                    : null);

            const artifact: CompactPairArtifact = {
                schema: "compact_pair_artifact.v1",
                pairIndex: pair.pairIndex,
                symbol: pairSymbol,
                baseAsset,
                quoteAsset,
                baseSymbol,
                quoteSymbol,
                trades: compactTrades,
                ...(dataEndTime !== null && Number.isFinite(dataEndTime)
                    ? { dataEndTime }
                    : {}),
            };

            artifacts.push(artifact);
            timing.artifactMs += performance.now() - artifactStartedAt;
            timing.completedPairs += 1;
            if (output.engineUsed === "rust") rustCount += 1;
            else typescriptCount += 1;

            if (parentPort) {
                parentPort.postMessage({
                    type: "progress",
                    shardIndex: data.shardIndex,
                    pairIndex: pair.pairIndex,
                    symbol: pairSymbol,
                    status: "completed",
                    engineUsed: output.engineUsed,
                } as TopMeanWorkerMessage);
            }
        } catch (err) {
            timing.failedPairs += 1;
            const message = err instanceof Error ? err.message : String(err);
            if (parentPort) {
                parentPort.postMessage({
                    type: "progress",
                    shardIndex: data.shardIndex,
                    pairIndex: pair.pairIndex,
                    symbol: pairSymbol,
                    status: "failed",
                    error: message,
                } as TopMeanWorkerMessage);
            }
        } finally {
            timing.pairWallMs += performance.now() - pairStartedAt;
        }
    }

    timing.shardWallMs = performance.now() - shardStartedAt;
    timing.cache = subtractCacheCounters(getServerBatchDatasetCacheStats(), cacheBefore);
    return {
        artifacts,
        engineUsage: { rust: rustCount, typescript: typescriptCount },
        performance: timing,
    };
}

if (!isMainThread && parentPort) {
    // Worker pool spawn contract: workers are spawned WITHOUT `workerData`
    // (see sp500-top-mean-worker-pool.ts "Persistent worker pool" comment) so
    // the one-shot branch that previously lived here was dead code — every
    // task arrives via the message listener. The single helper below replaces
    // the byte-identical then/catch bodies the two branches used to share.
    const postResult = (msg: TopMeanWorkerTaskData, result: Awaited<ReturnType<typeof processTopMeanShard>>): void => {
        parentPort?.postMessage({
            type: "shard_complete",
            shardIndex: msg.shardIndex,
            artifacts: result.artifacts,
            engineUsage: result.engineUsage,
            performance: result.performance,
        } as TopMeanWorkerMessage);
    };
    const postError = (msg: TopMeanWorkerTaskData, err: unknown): void => {
        parentPort?.postMessage({
            type: "error",
            shardIndex: msg.shardIndex,
            error: err instanceof Error ? err.message : String(err),
        } as TopMeanWorkerMessage);
    };

    parentPort.on("message", (msg: TopMeanWorkerTaskData) => {
        processTopMeanShard(msg).then(
            (result) => postResult(msg, result),
            (err) => postError(msg, err),
        );
    });
}
