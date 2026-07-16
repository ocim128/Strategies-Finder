import type { BatchSyntheticDirection, BatchSyntheticPreparedTargetArtifact, BatchSyntheticStateObservation, BatchSyntheticStateSnapshot } from "./batch-synthetic-state-miner";

export type BatchDirectionForecastBias = "UP" | "DOWN" | "NEUTRAL";
export type BatchDirectionForecastStatus = "EDGE" | "NO_EDGE" | "NO_ACTIVE_STATE" | "INSUFFICIENT" | "TARGET_UNAVAILABLE";
export type BatchDirectionForecastFreshness = "FRESH" | "STALE" | "UNKNOWN";

export interface BatchSignalLifecycleOutcome {
    entryIndex: number;
    exitIndex: number;
    entryPrice: number;
    exitPrice: number;
    rawReturnPct: number;
    maxUpPct: number;
    maxDownPct: number;
}

export interface BatchSignalLifecycle {
    direction: BatchSyntheticDirection;
    activationIndex: number;
    invalidationIndex: number | null;
    snapshots: BatchSyntheticStateSnapshot[];
    outcome: BatchSignalLifecycleOutcome | null;
}

export interface BatchSignalLifecycleAnalysis {
    asset: string;
    symbol: string;
    marketClock: "continuous" | "us_equities";
    target: BatchSyntheticPreparedTargetArtifact;
    linkedPairCount: number;
    timeline: BatchSyntheticStateObservation[];
    lifecycleDirectionByIndex: Array<BatchSyntheticDirection | null>;
    lifecycles: BatchSignalLifecycle[];
}

export interface BatchDirectionForecastRow {
    asset: string;
    symbol: string;
    aggregateDirection: BatchSyntheticDirection | null;
    asOfTimeKey: string | null;
    asOfPrice: number | null;
    bias: BatchDirectionForecastBias;
    status: BatchDirectionForecastStatus;
    reasonCode: string;
    freshness: BatchDirectionForecastFreshness;
    freshnessReason: string;
    lifecycleAge: number | null;
    agreementCount: number;
    oppositionCount: number;
    candidateCount: number;
    analogCount: number;
    probabilityPositive: number | null;
    probabilityLower: number | null;
    probabilityUpper: number | null;
    medianReturnPct: number | null;
    q1ReturnPct: number | null;
    q3ReturnPct: number | null;
    medianFavorableExcursionPct: number | null;
    medianAdverseExcursionPct: number | null;
    averageDistance: number | null;
    concentrationWarning: boolean;
    conservativeDirectionProbability: number | null;
    forecastDirectionReturnPct: number | null;
    returnToAdverseRatio: number | null;
}

export interface BatchDirectionExecutionAssumptions {
    initialCapital: number;
    commissionPercent: number;
    slippageBps: number;
}

export interface BatchDirectionPathMetrics {
    testStartTimeKey: string | null;
    testEndTimeKey: string | null;
    startEquity: number;
    realizedEquity: number;
    markedEquity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    returnPct: number;
    maxDrawdownPct: number;
    trades: number;
    winRate: number | null;
    profitFactor: number | null;
    exposurePct: number;
    turnover: number;
    ruin: boolean;
    top1PnlConcentration: number | null;
    top3PnlConcentration: number | null;
    worstTradeSymbol: string | null;
    worstTradeBias: BatchDirectionForecastBias | null;
    worstTradeEntryTimeKey: string | null;
    worstTradeExitTimeKey: string | null;
    worstTradeReturnPct: number | null;
    worstTradePnl: number | null;
}

export interface BatchDirectionForecastQuality {
    status: "VALID" | "INSUFFICIENT";
    selectedReturnPercentile: number | null;
    excessVsEligibleMedianPct: number | null;
    selectionHitRate: number | null;
    meanOpportunityRegretPct: number | null;
    rankIc: number | null;
    abstentionRate: number | null;
    comparableDecisions: number;
    excludedUnresolvedDecisions: number;
}

export interface BatchDirectionForecastBenchmarks {
    rawAgreement: BatchDirectionPathMetrics;
    randomMedianEquity: number;
    randomP05Equity: number;
    randomP95Equity: number;
    cashEquity: number;
}

export interface BatchDirectionSelectionPathResult {
    status: "OK" | "EXPLORATORY" | "FAILED" | "PATH_UNAVAILABLE";
    reasonCode: string;
    path: BatchDirectionPathMetrics;
    quality: BatchDirectionForecastQuality;
    benchmarks: BatchDirectionForecastBenchmarks;
}

export interface BatchDirectionForecastResult {
    schemaVersion: 1;
    interval: string;
    fingerprint: string;
    strategyKey: string | null;
    generatedAt: number;
    rows: BatchDirectionForecastRow[];
    selectionPath: BatchDirectionSelectionPathResult;
    diagnostics: string[];
}
