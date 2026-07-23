import type { Time } from "lightweight-charts";

export interface CompactTrade {
    type: "long" | "short";
    entryTime: Time;
    exitTime: Time;
    exitReason?: string;
}

export interface CompactPairArtifact {
    schema: "compact_pair_artifact.v1";
    pairIndex: number;
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    baseSymbol: string;
    quoteSymbol: string;
    trades: CompactTrade[];
    /**
     * Unix-second timestamp of the last closed candle the worker fed to
     * `executeBacktest(...)`. Used by the Phase-1 current-snapshot reducer to
     * align artifacts to a common cross-sectional endpoint before voting.
     * Optional for backward compatibility: v1 artifacts written before this
     * field existed omit it and remain readable, but cannot prove a precise
     * snapshot timestamp, so the reducer excludes them from the current vote.
     */
    dataEndTime?: number;
}

export interface TopMeanRunManifest {
    schema: "top_mean_run_manifest.v1";
    runId: string;
    status: "running" | "completed" | "interrupted" | "failed";
    fingerprint: string;
    strategyKey: string;
    interval: string;
    pairCount: number;
    shardSize: number;
    totalShards: number;
    completedShards: number[];
    failedShards: number[];
    completedPairsCount: number;
    failedPairsCount: number;
    createdAt: number;
    updatedAt: number;
    /** Engine preference and observed usage for status/reattach telemetry. */
    requestedEngineMode?: string;
    actualEngineMode?: string;
    engineUsage?: { rust: number; typescript: number };
    workerCount?: number;
    error?: string;
}

export interface BatchSyntheticPairArtifactAdapter {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    baseSymbol: string;
    quoteSymbol: string;
    data: never[];
    signals: never[];
    result: {
        trades: CompactTrade[];
    };
}

export function toBatchSyntheticPairAdapter(artifact: CompactPairArtifact): BatchSyntheticPairArtifactAdapter {
    return {
        symbol: artifact.symbol,
        baseAsset: artifact.baseAsset,
        quoteAsset: artifact.quoteAsset,
        baseSymbol: artifact.baseSymbol,
        quoteSymbol: artifact.quoteSymbol,
        data: [],
        signals: [],
        result: {
            trades: artifact.trades,
        },
    };
}
