import type { Time } from "lightweight-charts";
import type { ActiveCapTiltWeight } from "./cap-tilt-contract";
import type { OHLCVData } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";

export const DIRECTIONAL_VOTE_DELAY_BARS = 3;

/** Actual pair candles, never elapsed intervals or synthetic bridge candles. */
export function directionalVoteMaturityTime(candles: readonly OHLCVData[], entryTime: Time): number | null {
    const entry = timeToNumber(entryTime);
    if (entry === null) return null;
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const time = timeToNumber(candles[mid]!.time);
        if (time === null) return null;
        if (time < entry) lo = mid + 1;
        else hi = mid;
    }
    if (lo >= candles.length || timeToNumber(candles[lo]!.time) !== entry) return null;
    const mature = candles[lo + DIRECTIONAL_VOTE_DELAY_BARS];
    return mature ? timeToNumber(mature.time) : null;
}

export type TopMeanReplayMode = "horizon" | "asset_switch";

export interface CompactTrade {
    /** Third subsequent actual pair candle; null = not enough candles, absent = legacy artifact. */
    directionalMaturityTimeSec?: number | null;
    type: "long" | "short";
    entryTime: Time;
    exitTime: Time;
    exitReason?: string;
    /**
     * Net P&L of this trade from the pair's backtest. Feeds the causal
     * PROFIT_NOW arms (TOP_RAW_PROFIT_NOW / TOP_MEAN_PROFIT_NOW /
     * TOP_RAW_PROFIT_NOW_CONF / TOP_Z), which count
     * a pair's votes only when its P&L realized at or before the decision
     * strictly positive. Optional for backward compatibility: artifacts
     * written before this field existed carry no per-trade pnl, so those arms
     * see them as never-profitable and report 0 events.
     */
    pnl?: number;
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
     * Full-backtest net P&L carried from the pair's `BacktestResult`. Feeds
     * the profit-gated OPEN_SCORE arms (TOP_RAW_PROFIT / TOP_MEAN_PROFIT),
     * which count a pair's votes only when this value is strictly positive.
     * Optional for backward compatibility: artifacts written before this
     * field existed omit it and remain readable, but the pnl-gated arms see
     * them as non-profitable (those arms report 0 events for such archives).
     */
    netProfit?: number;
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
    /**
     * Optional for backward compatibility. Manifests written before affinity
     * scheduling used contiguous input-order shards. "asset_tile_v1" pins the
     * asset-tile partition (see buildTopMeanAssetTileShardTasks): a resumed
     * run must recompute exactly the partition that produced its persisted
     * completed-shard indexes.
     */
    shardOrder?: "input" | "leg_affinity_v1" | "asset_tile_v1";
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
    /**
     * Requested cap-tilt weighting for the phase-3 OPEN_SCORE USD replay
     * (docs/open-score-cap-tilt.md Phase 5). Absent = baseline. Written by
     * the coordinator engine on every manifest save so archived runs are
     * self-describing.
     */
    capTiltWeight?: ActiveCapTiltWeight;
    /** Effective replay selector cooldown; does not affect reusable pair-backtest shards. */
    selectionCooldownBars?: number;
    /** Replay-only discriminator; omitted old manifests mean horizon. */
    replayMode?: TopMeanReplayMode;
    error?: string;
    archiveComplete?: boolean;
    archiveRequested?: boolean;
    archiveDir?: string;
    archiveError?: string;
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
        /** Present only when the stored compact artifact carries it. */
        netProfit?: number;
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
            netProfit: artifact.netProfit,
        },
    };
}
