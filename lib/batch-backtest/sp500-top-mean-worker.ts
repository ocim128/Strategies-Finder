import { parentPort, workerData, isMainThread } from "node:worker_threads";
import { executeBacktest, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import { parsePortfolioSyntheticPairSymbol } from "../synthetic-pair-parser";
import { stripIbkrMarker } from "../local-daily-datasets";
import type { CompactPairArtifact, CompactTrade } from "./compact-pair-artifact";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
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
}

export type TopMeanWorkerMessage =
    | {
          type: "progress";
          shardIndex: number;
          pairIndex: number;
          symbol: string;
          status: "completed" | "failed";
          error?: string;
      }
    | {
          type: "shard_complete";
          shardIndex: number;
          artifacts: CompactPairArtifact[];
      }
    | {
          type: "error";
          shardIndex: number;
          error: string;
      };

export async function processTopMeanShard(data: TopMeanWorkerTaskData): Promise<CompactPairArtifact[]> {
    const strategy = strategies[data.strategyKey];
    if (!strategy) {
        throw new Error(`Built-in strategy "${data.strategyKey}" not found in manifest.`);
    }

    const preResolvedSettings = resolveExecutorBacktestSettings(data.backtestSettings, data.interval);
    const preResolvedCapital = resolveCapitalSettingsFromRaw(data.capitalSettings as any);
    const nowSec = Math.floor(Date.now() / 1000);

    const artifacts: CompactPairArtifact[] = [];

    for (const pair of data.pairs) {
        let pairSymbol = pair.symbol;
        const parsed = parsePortfolioSyntheticPairSymbol(pairSymbol);

        const baseAsset = parsed ? parsed.baseAsset : stripIbkrMarker(pairSymbol);
        const quoteAsset = parsed ? parsed.quoteAsset : stripIbkrMarker(pairSymbol);
        const baseSymbol = parsed ? parsed.baseSymbol : pairSymbol;
        const quoteSymbol = parsed ? parsed.quoteSymbol : pairSymbol;

        try {
            const candles = await loadServerBatchDataset(pairSymbol, data.interval);
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

            const output = await executeBacktest({
                ohlcvData: candles,
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

            const artifact: CompactPairArtifact = {
                schema: "compact_pair_artifact.v1",
                pairIndex: pair.pairIndex,
                symbol: pairSymbol,
                baseAsset,
                quoteAsset,
                baseSymbol,
                quoteSymbol,
                trades: compactTrades,
            };

            artifacts.push(artifact);

            if (parentPort) {
                parentPort.postMessage({
                    type: "progress",
                    shardIndex: data.shardIndex,
                    pairIndex: pair.pairIndex,
                    symbol: pairSymbol,
                    status: "completed",
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

    return artifacts;
}

if (!isMainThread && parentPort) {
    if (workerData) {
        processTopMeanShard(workerData as TopMeanWorkerTaskData)
            .then((artifacts) => {
                parentPort?.postMessage({
                    type: "shard_complete",
                    shardIndex: (workerData as TopMeanWorkerTaskData).shardIndex,
                    artifacts,
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
            .then((artifacts) => {
                parentPort?.postMessage({
                    type: "shard_complete",
                    shardIndex: msg.shardIndex,
                    artifacts,
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
