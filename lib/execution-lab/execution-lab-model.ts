import type { Time } from "lightweight-charts";
import type { BacktestSettings, OHLCVData, Signal, StrategyParams, Trade } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { PolymarketExitMode } from "../polymarket-exit-mode";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type { PolymarketClob1sQuoteRow, SecondMarketSide, SecondMarketSymbol } from "../second-market/types";

export const EXECUTION_LAB_DEFAULT_STAKE_USD = 5;
export const EXECUTION_LAB_SETTINGS_STORAGE_KEY = "executionLabSettings";

export type ExecutionLabBacktestExitReason = Exclude<NonNullable<Trade["exitReason"]>, "end_of_data" | "partial">;
export type ExecutionLabPaperExitReason = ExecutionLabBacktestExitReason | "resolution";

export interface ExecutionLabSessionSnapshot {
    sessionId: string;
    symbol: SecondMarketSymbol;
    outcomeSymbol: SecondMarketSymbol;
    interval: "1s";
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    backtestSettings: BacktestSettings;
    capitalSettings: CapitalSettings;
    polymarketSettings: Record<string, unknown>;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
    exitMode: PolymarketExitMode;
    allowMultipleTradesPerEvent: boolean;
    stakeUsd: number;
    startedAtIso: string;
}

export interface ExecutionLabEvaluatedSignal {
    signal: Signal;
    signalTimeSec: number;
    signalType: "buy" | "sell";
}

export interface ExecutionLabPaperTickInput {
    latestCandleTimeSec: number;
    latestCandle: OHLCVData;
    trades: Trade[];
    signals: ExecutionLabEvaluatedSignal[];
    quotes: PolymarketClob1sQuoteRow[];
    outcomes: PolymarketOutcomeRow[];
    recordedAtIso: string;
    feedLagSec: number | null;
}

export interface ExecutionLabOpenPaperPosition {
    tradeId: string;
    sourceTrade: Trade;
    seriesId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    yesTokenId: string;
    noTokenId: string;
    side: SecondMarketSide;
    chartDirection: "long" | "short";
    signalTimeSec: number;
    entryTimeSec: number;
    entryQuoteTs: number;
    entryPrice: number;
    stakeUsd: number;
    shares: number;
}

export interface ExecutionLabClosedPaperTrade {
    tradeId: string;
    side: SecondMarketSide;
    chartDirection: "long" | "short";
    entryTimeSec: number;
    exitTimeSec: number;
    entryPrice: number;
    exitPrice: number;
    stakeUsd: number;
    shares: number;
    pnlUsd: number;
    roiPct: number;
    exitReason: ExecutionLabPaperExitReason;
    marketSlug: string;
}

export interface ExecutionLabPaperState {
    snapshot: ExecutionLabSessionSnapshot;
    lastProcessedCandleTimeSec: number | null;
    loggedFingerprints: Set<string>;
    claimedEventKeys: Set<string>;
    openPositions: Map<string, ExecutionLabOpenPaperPosition>;
    pendingSettlements: Map<string, ExecutionLabOpenPaperPosition>;
    closedTrades: ExecutionLabClosedPaperTrade[];
    realizedPnlUsd: number;
    totalEntries: number;
    totalClosed: number;
}

export interface ExecutionLabPaperMarker {
    id: string;
    time: Time;
    kind: "entry" | "exit";
    side: SecondMarketSide;
    text: string;
}

export interface ExecutionLabPaperTickResult {
    records: ExecutionLabRecord[];
    markers: ExecutionLabPaperMarker[];
    acceptedEntries: ExecutionLabOpenPaperPosition[];
}

export type ExecutionLabBaseRecord = {
    recordType: string;
    sessionId: string;
    recordedAtIso: string;
    symbol: string;
    interval: "1s";
    strategyKey: string;
};

export type SessionStartRecord = ExecutionLabBaseRecord & {
    recordType: "session_start";
    stakeUsd: number;
    strategyName: string;
    params: Record<string, number>;
    backtestSettings: Record<string, unknown>;
    polymarketSettings: Record<string, unknown>;
    liveConfig?: ExecutionLabLiveUiConfig;
    allowMultipleTradesPerEvent: boolean;
};

export type SignalSeenRecord = ExecutionLabBaseRecord & {
    recordType: "signal_seen";
    signalTimeSec: number;
    signalType: "buy" | "sell";
    signalPrice: number;
    signalReason?: string;
    candleClose: number;
    latestCandleTimeSec: number;
    feedLagSec: number | null;
};

export type PaperEntryRecord = ExecutionLabBaseRecord & {
    recordType: "paper_entry";
    tradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    side: SecondMarketSide;
    chartDirection: "long" | "short";
    signalTimeSec: number;
    entryTimeSec: number;
    entryQuoteTs: number;
    entryPrice: number;
    stakeUsd: number;
    shares: number;
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
    quoteAgeMs: number | null;
};

export type LiveOrderMode = "taker" | "limit";
export type LiveTakerOrderType = "FOK" | "FAK";
export type LiveLimitOrderType = "GTC";
export type LiveTradeSizingMode = "fixed" | "exchange_min";
export type LiveCancelScope = "account" | "market" | "token" | "session" | "unknown";

export interface ExecutionLabLiveUiConfig {
    orderMode: LiveOrderMode;
    takerOrderType: LiveTakerOrderType;
    sizingMode: LiveTradeSizingMode;
    maxStakeUsd: number;
    entryMaxSlippageCents: number;
    exitMaxSlippageCents: number;
    limitOffsetEnabled: boolean;
    limitOffsetCents: number;
    limitFixedPriceEnabled: boolean;
    limitFixedPriceCents: number;
    limitCancelAllOnExitEnabled: boolean;
}

export type LiveExecutorKind = "cli" | "http";

export type ExecutionLabResolvedLiveConfig = ExecutionLabLiveUiConfig & {
    ok: true;
    configured: boolean;
    available: boolean;
    liveEnabled: boolean;
    dryRun: boolean;
    executorKind: LiveExecutorKind;
    geoblockAllowed: boolean | null;
    orderType: LiveTakerOrderType;
    supportedOrderTypes: LiveTakerOrderType[];
    supportedTakerOrderTypes: LiveTakerOrderType[];
    supportedLimitOrderType: LiveLimitOrderType | null;
    cancelScope: LiveCancelScope;
    message: string;
};

export type LiveExecutorStatus = ExecutionLabResolvedLiveConfig;

export type LiveTradeSubmitStatus =
    | "dry_run"
    | "rejected"
    | "posted_live"
    | "matched"
    | "delayed"
    | "partial"
    | "duplicate"
    | "failed";

export type LiveTradeSubmitRequestBase = {
    requestId: string;
    sessionId: string;
    paperTradeId: string;
    createdAtIso: string;
    expiresAtSec: number;
    symbol: string;
    strategyKey: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    stakeUsd: number;
    signalTimeSec: number;
    entryTimeSec: number;
};

export type LiveTakerEntrySubmitRequest = LiveTradeSubmitRequestBase & {
    action: "entry";
    orderMode: "taker";
    orderType: LiveTakerOrderType;
    maxPrice: number;
};

export type LiveLimitEntrySubmitRequest = LiveTradeSubmitRequestBase & {
    action: "entry";
    orderMode: "limit";
    orderType: LiveLimitOrderType;
    maxPrice: number;
    limitPrice: number;
    limitReferencePrice: number;
    limitOffsetEnabled: boolean;
    limitOffsetCents: number;
    limitFixedPriceEnabled: boolean;
    limitFixedPriceCents: number;
};

export type LiveEntrySubmitRequest = LiveTakerEntrySubmitRequest | LiveLimitEntrySubmitRequest;

export type LiveTakeProfitSubmitRequest = LiveTradeSubmitRequestBase & {
    action: "take_profit";
    entryRequestId: string;
    orderMode: "limit";
    orderType: LiveLimitOrderType;
    maxPrice: number;
    limitPrice: number;
    limitReferencePrice: number;
    shares: number;
    exitTimeSec: number;
    minPrice: number;
};

export type LiveExitSubmitRequest = LiveTradeSubmitRequestBase & {
    action: "exit";
    entryRequestId: string;
    orderMode: "taker";
    orderType: LiveTakerOrderType;
    maxPrice: number;
    shares: number;
    exitTimeSec: number;
    minPrice: number;
    attempt?: number;
};

export type LiveTradeSubmitRequest = LiveEntrySubmitRequest | LiveTakeProfitSubmitRequest | LiveExitSubmitRequest;

export type LiveTradeSubmitResponse = {
    ok: true;
    requestId: string;
    status: LiveTradeSubmitStatus;
    reason?: string;
    orderId?: string;
    orderStatus?: string;
    orderSuccess?: boolean;
    submittedPrice?: number;
    submittedShares?: number;
    submittedNotionalUsd?: number;
    filledShares?: number;
    maxPrice?: number;
    currentAsk?: number;
    limitPrice?: number;
    limitReferencePrice?: number;
    limitOffsetEnabled?: boolean;
    limitOffsetCents?: number;
    limitFixedPriceEnabled?: boolean;
    limitFixedPriceCents?: number;
    minPrice?: number;
    currentBid?: number;
    minOrderSize?: number;
    minTickSize?: number;
};

export type LiveTradeRequestRecord = ExecutionLabBaseRecord & {
    recordType: "live_trade_request";
    action?: "entry" | "take_profit";
    requestId: string;
    paperTradeId: string;
    entryRequestId?: string;
    expiresAtSec?: number;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    stakeUsd: number;
    signalTimeSec: number;
    entryTimeSec: number;
    shares?: number;
    exitTimeSec?: number;
    orderMode: LiveOrderMode;
    orderType: LiveTakerOrderType | LiveLimitOrderType;
    maxPrice?: number;
    minPrice?: number;
    limitPrice?: number;
    limitReferencePrice?: number;
    limitOffsetEnabled?: boolean;
    limitOffsetCents?: number;
    limitFixedPriceEnabled?: boolean;
    limitFixedPriceCents?: number;
    sizingMode?: LiveTradeSizingMode;
    dryRun?: boolean;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type LiveTradeResultRecord = ExecutionLabBaseRecord & {
    recordType: "live_trade_result";
    action?: "entry" | "take_profit";
    requestId: string;
    paperTradeId: string;
    status: LiveTradeSubmitStatus;
    reason?: string;
    orderId?: string;
    orderStatus?: string;
    orderSuccess?: boolean;
    submittedPrice?: number;
    submittedShares?: number;
    submittedNotionalUsd?: number;
    filledShares?: number;
    currentAsk?: number;
    maxPrice?: number;
    limitPrice?: number;
    limitReferencePrice?: number;
    limitOffsetEnabled?: boolean;
    limitOffsetCents?: number;
    limitFixedPriceEnabled?: boolean;
    limitFixedPriceCents?: number;
    minPrice?: number;
    currentBid?: number;
    latencyMs?: number;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type LiveExitRequestRecord = ExecutionLabBaseRecord & {
    recordType: "live_exit_request";
    requestId: string;
    entryRequestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: SecondMarketSide;
    shares: number;
    exitTimeSec: number;
    minPrice: number;
    orderMode: "taker";
    orderType: LiveTakerOrderType;
    expiresAtSec?: number;
    attempt?: number;
    sizingMode?: LiveTradeSizingMode;
    dryRun?: boolean;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type LiveExitResultRecord = ExecutionLabBaseRecord & {
    recordType: "live_exit_result";
    requestId: string;
    entryRequestId: string;
    paperTradeId: string;
    status: LiveTradeSubmitStatus;
    reason?: string;
    orderId?: string;
    orderStatus?: string;
    orderSuccess?: boolean;
    submittedPrice?: number;
    submittedShares?: number;
    submittedNotionalUsd?: number;
    filledShares?: number;
    currentBid?: number;
    minPrice?: number;
    latencyMs?: number;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type LiveCancelAllSubmitStatus =
    | "dry_run"
    | "submitted"
    | "partial"
    | "duplicate"
    | "rejected"
    | "failed";

export type LiveCancelAllSubmitRequest = {
    action: "cancel_all";
    requestId: string;
    sessionId: string;
    paperTradeId?: string;
    exitTriggerKey: string;
    createdAtIso: string;
    symbol: string;
    strategyKey: string;
    marketSlug?: string;
    conditionId?: string;
    tokenId?: string;
    orderIds?: string[];
    scope: LiveCancelScope;
    reason: "limit_exit_signal";
    orderMode: "limit";
};

export type LiveCancelAllSubmitResponse = {
    ok: true;
    requestId: string;
    status: LiveCancelAllSubmitStatus;
    reason?: string;
    scope: LiveCancelScope;
    canceledOrderIds?: string[];
    canceledCount?: number;
};

export type LiveCancelAllRequestRecord = ExecutionLabBaseRecord & {
    recordType: "live_cancel_all_request";
    requestId: string;
    paperTradeId?: string;
    exitTriggerKey: string;
    marketSlug?: string;
    conditionId?: string;
    tokenId?: string;
    orderIds?: string[];
    scope: LiveCancelScope;
    reason: "limit_exit_signal";
    orderMode: "limit";
    dryRun?: boolean;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type LiveCancelAllResultRecord = ExecutionLabBaseRecord & {
    recordType: "live_cancel_all_result";
    requestId: string;
    paperTradeId?: string;
    status: LiveCancelAllSubmitStatus;
    reason?: string;
    scope: LiveCancelScope;
    canceledOrderIds?: string[];
    canceledCount?: number;
    latencyMs?: number;
    liveEnabled?: boolean;
    executorKind?: LiveExecutorKind;
};

export type PaperUnfilledRecord = ExecutionLabBaseRecord & {
    recordType: "paper_unfilled";
    reason: "missing_event" | "missing_entry_quote" | "missing_exit_quote" | "duplicate_event" | "open_position" | "invalid_price" | "entry_price_filtered" | "entry_too_close_to_close";
    tradeId?: string;
    signalTimeSec: number;
    entryTimeSec: number | null;
    expectedExitTimeSec?: number;
    expectedExitReason?: string;
    side: SecondMarketSide | null;
    entryPrice?: number;
    eventStartTs?: number;
    eventEndTs?: number;
    marketSlug?: string;
};

export type PaperExitRecord = ExecutionLabBaseRecord & {
    recordType: "paper_exit";
    tradeId: string;
    exitReason: ExecutionLabPaperExitReason;
    exitTimeSec: number;
    exitQuoteTs: number | null;
    exitPrice: number;
    entryPrice: number;
    stakeUsd: number;
    shares: number;
    pnlUsd: number;
    roiPct: number;
    marketSlug: string;
};

export type PaperResolutionPendingRecord = ExecutionLabBaseRecord & {
    recordType: "paper_resolution_pending";
    tradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
};

export type ExecutionParityMismatchRecord = ExecutionLabBaseRecord & {
    recordType: "execution_parity_mismatch";
    mismatchType: "paper_open_after_backtest_exit" | "paper_open_after_event_end" | "missing_exit_quote" | "entry_price_filter_violation" | "late_paper_execution";
    latestCandleTimeSec: number;
    detail: string;
    tradeId?: string;
    expectedExitTimeSec?: number;
    expectedExitReason?: string;
    eventEndTs?: number;
};

export type SessionStopRecord = ExecutionLabBaseRecord & {
    recordType: "session_stop";
    reason: "user_stop" | "error";
    message?: string;
    totalEntries: number;
    totalClosed: number;
    realizedPnlUsd: number;
};

export type ExecutionLabRecord =
    | SessionStartRecord
    | SignalSeenRecord
    | PaperEntryRecord
    | LiveTradeRequestRecord
    | LiveTradeResultRecord
    | LiveExitRequestRecord
    | LiveExitResultRecord
    | LiveCancelAllRequestRecord
    | LiveCancelAllResultRecord
    | PaperUnfilledRecord
    | PaperExitRecord
    | PaperResolutionPendingRecord
    | ExecutionParityMismatchRecord
    | SessionStopRecord;
