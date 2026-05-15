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

export type PaperUnfilledRecord = ExecutionLabBaseRecord & {
    recordType: "paper_unfilled";
    reason: "missing_event" | "missing_entry_quote" | "missing_exit_quote" | "duplicate_event" | "open_position" | "invalid_price" | "entry_price_filtered";
    signalTimeSec: number;
    entryTimeSec: number | null;
    expectedExitTimeSec?: number;
    expectedExitReason?: string;
    side: SecondMarketSide | null;
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
    | PaperUnfilledRecord
    | PaperExitRecord
    | PaperResolutionPendingRecord
    | ExecutionParityMismatchRecord
    | SessionStopRecord;
