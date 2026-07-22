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
