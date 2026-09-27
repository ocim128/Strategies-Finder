import { parentPort, isMainThread } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { executeBacktest, prepareClosedCandleData, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { clearServerBatchDatasetCaches, getServerBatchDatasetCacheStats, loadServerBatchDataset } from "./server-batch-data-loader";
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

/**
 * Detailed engine-diagnostic sampling stride (shard-overhead plan phase 2):
 * a pair is sampled when its ORIGINAL pairIndex is divisible by this stride,
 * independently of shard boundaries — the former first-pair-per-shard rule
 * turned diagnostic sampling into near-full instrumentation once the tile
 * layout shrank shards to a couple of pairs. Exported for the worker spec.
 */
export const TOP_MEAN_ENGINE_DIAGNOSTIC_SAMPLE_STRIDE = 250;

export function isTopMeanEngineDiagnosticSample(pairIndex: number): boolean {
    return pairIndex % TOP_MEAN_ENGINE_DIAGNOSTIC_SAMPLE_STRIDE === 0;
}

/**
 * The exact run options a worker hands to executeBacktest. Exported so the
 * spec can assert the real execution options, not just the sampling
 * predicate: detailed diagnostics ride a copy of the frozen defaults,
 * everything else runs on the shared frozen object unchanged.
 */
export function resolveTopMeanEngineRunOptions(
    collectEngineDiagnostics: boolean,
): typeof TOP_MEAN_BACKTEST_RUN_OPTIONS | (typeof TOP_MEAN_BACKTEST_RUN_OPTIONS & { collectDiagnostics: true }) {
    return collectEngineDiagnostics
        ? { ...TOP_MEAN_BACKTEST_RUN_OPTIONS, collectDiagnostics: true }
        : TOP_MEAN_BACKTEST_RUN_OPTIONS;
}

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
    preferInMemorySyntheticPairs?: boolean;
    /**
     * Run-level closed-candle cutoff (unix seconds). The coordinator captures
     * ONE timestamp per run and threads it through every task so all pairs in
     * a run share the same dataEndTime semantics; per-shard Date.now() made a
     * long run crossing a candle boundary temporally inconsistent.
     */
    nowSec?: number;
}

export type TopMeanWorkerMessage =
    | {
          type: "progress";
          shardIndex: number;
          pairIndex: number;
          symbol: string;
          status: "completed" | "failed";
          error?: string;
          failureKind?: "missing_data" | "backtest";
          /** Engine that actually executed the pair backtest (not the preference). */
          engineUsed?: "rust" | "typescript";
      }
      | {
          /** Pool -> worker (finder_arm sweep reuse): drop module-level dataset caches before a new candidate. */
          type: "clear_caches";
      }
      | {
          /** Worker -> pool acknowledgement for clear_caches. */
          type: "caches_cleared";
      }
    | {
          type: "shard_complete";
          shardIndex: number;
          /**
           * UTF-8 JSON of the shard's CompactPairArtifact array, serialized
           * once in the worker and TRANSFERRED (owned ArrayBuffer) so the
           * coordinator never structured-clones artifact objects or
           * re-stringifies them for persistence (shard byte-transfer phase).
           */
          artifactsBytes: ArrayBuffer;
          engineUsage?: { rust: number; typescript: number };
          performance: TopMeanWorkerTiming;
      }
    | {
          type: "error";
          shardIndex: number;
          error: string;
      };

/**
 * Serialize a shard's artifacts into a dedicated owned ArrayBuffer for the
 * shard_complete transfer (top-mean coordinator optimization plan, idea #3).
 * Exported for the worker-message contract test.
 */
export function serializeShardArtifacts(artifacts: CompactPairArtifact[]): ArrayBuffer {
    // The encoder returns storage it owns (fresh buffer, byteOffset 0), so its
    // backing buffer IS the owned bytes: transfer it directly instead of
    // copying into a second equal-sized ArrayBuffer (allocation reduction
    // plan phase 3). JSON encoding and durable disk writes are unchanged, and
    // postResult still transfers exactly this buffer.
    return new TextEncoder().encode(JSON.stringify(artifacts)).buffer as ArrayBuffer;
}

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
    const nowSec = data.nowSec ?? Math.floor(Date.now() / 1000);

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
        let loadFailed = false;

        try {
            const loadStartedAt = performance.now();
            let candles: OHLCVData[];
            try {
                try {
                    candles = await loadServerBatchDataset(
                        pairSymbol,
                        data.interval,
                        undefined,
                        data.preferInMemorySyntheticPairs
                            ? { preferInMemorySyntheticPairs: true }
                            : undefined,
                    );
                } catch (error) {
                    loadFailed = true;
                    throw error;
                }
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
                        failureKind: "missing_data",
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
            // Detailed diagnostics sample by ORIGINAL pair index (shard-
            // overhead plan phase 2), so the same pairs are eligible no matter
            // how shards are partitioned, assigned, or resumed. Executor
            // timings still collect for every pair; the diagnostic counters
            // below accumulate only results that actually contain them.
            const collectEngineDiagnostics = isTopMeanEngineDiagnosticSample(pair.pairIndex);
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
                    engineMode: "auto",
                    useRustEnginePreference: data.useRustEnginePreference,
                    nowSec,
                },
                backtestRunOptions: resolveTopMeanEngineRunOptions(collectEngineDiagnostics),
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
                pnl: t.pnl,
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
                // Dropped by JSON.stringify when undefined, so artifacts from
                // results without a netProfit keep the old shape.
                netProfit: output.result?.netProfit,
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
                    failureKind: loadFailed ? "missing_data" : "backtest",
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
    // Worker pool spawn contract: workers receive TOP_MEAN cache metadata;
    // every task arrives via the message listener. The single helper below
    // the one-shot branch that previously lived here was dead code — every
    // task arrives via the message listener. The single helper below replaces
    // the byte-identical then/catch bodies the two branches used to share.
    const postResult = (msg: TopMeanWorkerTaskData, result: Awaited<ReturnType<typeof processTopMeanShard>>): void => {
        // Serialize once here and transfer the owned bytes: the coordinator
        // persists them verbatim instead of structured-cloning artifact
        // objects and re-stringifying them (shard byte-transfer phase).
        const artifactsBytes = serializeShardArtifacts(result.artifacts);
        parentPort?.postMessage({
            type: "shard_complete",
            shardIndex: msg.shardIndex,
            artifactsBytes,
            engineUsage: result.engineUsage,
            performance: result.performance,
        } as TopMeanWorkerMessage, [artifactsBytes]);
    };
    const postError = (msg: TopMeanWorkerTaskData, err: unknown): void => {
        parentPort?.postMessage({
            type: "error",
            shardIndex: msg.shardIndex,
            error: err instanceof Error ? err.message : String(err),
        } as TopMeanWorkerMessage);
    };

    parentPort.on("message", (msg: TopMeanWorkerTaskData) => {
        // finder_arm sweep reuse: retained workers carry module-level dataset
        // caches from the previous candidate. The leg/pair LRUs key without a
        // source version, so a later candidate must start from empty caches —
        // source files can change between children.
        if ((msg as { type?: string }).type === "clear_caches") {
            clearServerBatchDatasetCaches();
            parentPort?.postMessage({ type: "caches_cleared" } as TopMeanWorkerMessage);
            return;
        }
        processTopMeanShard(msg).then(
            (result) => {
                // A throw inside this fulfillment handler would NOT reach the
                // sibling failure handler — serialization/posting errors must
                // still surface as a shard error message.
                try {
                    postResult(msg, result);
                } catch (err) {
                    postError(msg, err);
                }
            },
            (err) => postError(msg, err),
        );
    });
}
