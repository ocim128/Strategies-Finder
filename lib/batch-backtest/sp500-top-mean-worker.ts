import { parentPort, workerData, isMainThread } from "node:worker_threads";
import { executeBacktest, prepareClosedCandleData, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { stripIbkrMarker } from "../local-daily-datasets";
import { selectClosedCandleWindow } from "../alert-evaluation-window";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { CompactPairArtifact, CompactTrade } from "./compact-pair-artifact";
import type { BacktestSettings, OHLCVData, StrategyParams } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import { strategies } from "../strategies/library";

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
    /**
     * Optional start-date slice (unix seconds) for the stability mode. When
     * set, the worker trims its loaded candles to [backtestFromSec, inf)
     * BEFORE executeBacktest so the open position reflects a simulation that
     * started at this date. Undefined = full history.
     */
    backtestFromSec?: number;
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
      }
    | {
          type: "error";
          shardIndex: number;
          error: string;
      };

/**
 * Trim a loaded pair dataset to the stability simulation window. Keeping this
 * as a small pure seam makes the ordering explicit and testable: the slice
 * happens before the worker's minimum-candle guard and before execution.
 */
export function sliceTopMeanCandlesFromSec(candles: OHLCVData[], fromSec?: number): OHLCVData[] {
    if (fromSec === undefined) return candles;
    return candles.filter((candle) => {
        const timestamp = parseTimeToUnixSeconds(candle.time);
        return timestamp !== null && timestamp >= fromSec;
    });
}

export async function processTopMeanShard(data: TopMeanWorkerTaskData): Promise<{ artifacts: CompactPairArtifact[]; engineUsage: { rust: number; typescript: number } }> {
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

    for (const pair of data.pairs) {
        let pairSymbol = pair.symbol;
        const parsed = parsePortfolioSyntheticPairSymbol(pairSymbol);

        const baseAsset = parsed ? parsed.baseAsset : stripIbkrMarker(pairSymbol);
        const quoteAsset = parsed ? parsed.quoteAsset : stripIbkrMarker(pairSymbol);
        const baseSymbol = parsed ? parsed.baseSymbol : pairSymbol;
        const quoteSymbol = parsed ? parsed.quoteSymbol : pairSymbol;

        try {
            let candles = await loadServerBatchDataset(pairSymbol, data.interval);

            // Stability mode: trim loaded candles to [backtestFromSec, inf) so
            // the open position reflects a simulation that started at this
            // date. The slice is applied BEFORE the < 200 guard, so a window
            // that yields too few candles is skipped per-pair rather than
            // crashing. dataEndTime then naturally reflects the trimmed
            // window's last closed candle.
            if (candles && candles.length > 0) {
                candles = sliceTopMeanCandlesFromSec(candles, data.backtestFromSec);
            }

            if (!candles || candles.length < 200) {
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
            const closedCandleData = prepareClosedCandleData(
                candles,
                data.interval,
                data.backtestSettings,
                nowSec,
            );
            const closedWindow = selectClosedCandleWindow(candles, data.interval, nowSec, 1);

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
                backtestRunOptions: {
                    includeAdvancedAnalytics: false,
                    omitEquityCurve: true,
                    skipDrawdown: false,
                    skipResultPostProcessing: true,
                },
            });

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
        }
    }

    return { artifacts, engineUsage: { rust: rustCount, typescript: typescriptCount } };
}

if (!isMainThread && parentPort) {
    if (workerData) {
        processTopMeanShard(workerData as TopMeanWorkerTaskData)
            .then((result) => {
                parentPort?.postMessage({
                    type: "shard_complete",
                    shardIndex: (workerData as TopMeanWorkerTaskData).shardIndex,
                    artifacts: result.artifacts,
                    engineUsage: result.engineUsage,
                } as TopMeanWorkerMessage);
            })
            .catch((err) => {
                parentPort?.postMessage({
                    type: "error",
                    shardIndex: (workerData as TopMeanWorkerTaskData).shardIndex,
                    error: err instanceof Error ? err.message : String(err),
                } as TopMeanWorkerMessage);
            });
    }

    parentPort.on("message", (msg: TopMeanWorkerTaskData) => {
        processTopMeanShard(msg)
            .then((result) => {
                parentPort?.postMessage({
                    type: "shard_complete",
                    shardIndex: msg.shardIndex,
                    artifacts: result.artifacts,
                    engineUsage: result.engineUsage,
                } as TopMeanWorkerMessage);
            })
            .catch((err) => {
                parentPort?.postMessage({
                    type: "error",
                    shardIndex: msg.shardIndex,
                    error: err instanceof Error ? err.message : String(err),
                } as TopMeanWorkerMessage);
            });
    });
}
