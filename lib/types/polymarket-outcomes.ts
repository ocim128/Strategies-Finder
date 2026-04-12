import type { CapitalSettings } from "./backtest";
import type { BacktestSettings } from "./strategies";

export interface PolymarketOutcomeRow {
    series_id: string;
    event_slug: string;
    market_slug: string;
    interval: string;
    event_start_ts: number;
    event_end_ts: number;
    yes_token_id: string;
    no_token_id: string;
    yes_open_price: number | null;
    yes_entry_minute_1_price: number | null;
    yes_entry_minute_2_price: number | null;
    yes_entry_minute_3_price: number | null;
    yes_entry_minute_4_price: number | null;
    resolved_outcome_up: 0 | 1;
    resolution_source: string;
    updated_at: number;
}

export interface PolymarketEvalRow {
    eventStartTs: number;
    eventEndTs: number;
    eventSlug: string;
    signalBarIndex: number;
    signalTime: number;
    prediction: 'yes' | 'no';
    actualOutcomeUp: 0 | 1;
    isWin: boolean;
    signalReason: string | undefined;
    strategyKey: string | undefined;
    /** Entry offset minute within 5m event (0..4), only populated for 1m runs */
    entryOffset?: number;
}

export interface TradePolymarketOutcome {
    eventStartTs: number;
    eventEndTs: number;
    eventSlug: string;
    marketSlug: string;
    prediction: 'yes' | 'no';
    actualOutcomeUp: 0 | 1;
    isWin: boolean;
    /** Raw YES checkpoint price for the selected entry offset. */
    marketYesPrice?: number | null;
    /** Raw NO checkpoint price for the selected entry offset. */
    marketNoPrice?: number | null;
    /** Entry probability paid for this trade (YES for longs, NO for shorts). */
    marketEntryPrice?: number | null;
    /** Entry offset minute within 5m event (0..4), only populated for 1m runs */
    entryOffset?: number;
    /** Which evaluation mode produced this outcome annotation */
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    /** Whether the Polymarket trade was profitable (signal-exit aware, not binary outcome) */
    isProfitable?: boolean | null;
    /** Exit price from the Polymarket contract */
    marketExitPrice?: number | null;
    /** Exit timestamp for the Polymarket leg */
    marketExitTs?: number | null;
    /** How the Polymarket leg exited: signal (same-event) or resolution (final outcome) */
    marketExitSource?: "signal" | "resolution";
    /** PnL for the Polymarket leg: marketExitPrice - marketEntryPrice */
    marketPnl?: number | null;
}

export interface BacktestPolymarketTimingProfileEntry {
    entryOffset: number;
    scoredTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    coverage: number;
    missingOutcomeRows: number;
    duplicateTradesIgnored: number;
}

export interface BacktestPolymarketTradeSummary {
    seriesId: string;
    outcomeSymbol?: string;
    outcomeRowsLoaded: number;
    scoredTrades: number;
    missingOutcomeTrades: number;
    unscoredTrades?: number;
    entryOffset?: number;
    duplicateTradesIgnored?: number;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    profitableTrades?: number;
    losingTrades?: number;
    signalExitedTrades?: number;
    resolvedTrades?: number;
    missingPriceTrades?: number;
    netPnl?: number;
    grossProfit?: number;
    grossLoss?: number;
    profitFactor?: number;
    expectancy?: number;
    avgEntryPrice?: number;
    avgExitPrice?: number;
}

export interface PolymarketEvalResult {
    evaluatedEvents: number;
    predictionsTaken: number;
    scoredPredictions: number;
    pricedPredictions?: number;
    profitFactor?: number;
    grossProfit?: number;
    grossLoss?: number;
    wins: number;
    losses: number;
    skips: number;
    winRate: number;
    coverage: number;
    longPredictions: number;
    shortPredictions: number;
    longWins: number;
    shortWins: number;
    longWinRate: number;
    shortWinRate: number;
    alwaysYesBaselineWinRate: number;
    alwaysNoBaselineWinRate: number;
    avgEntryPrice?: number;
    breakEvenWinRate?: number;
    expectancy?: number;
    edgeVsBreakEven?: number;
    missingOutcomeRows: number;
    ignoredSignals: number;
    /** Entry offset used for scoring (0..4), only for 1m runs */
    entryOffset?: number;
    /** Number of duplicate trades ignored due to same-event deduplication */
    duplicateTradesIgnored?: number;
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    signalExitedTrades?: number;
    resolvedTrades?: number;
    missingPriceTrades?: number;
    netPnl?: number;
    avgExitPrice?: number;
    rows: PolymarketEvalRow[];
}

export interface PolymarketEvalOptions {
    executionMode?: 'next_open';
    tradeDirection?: 'long' | 'short' | 'both';
    usePreparedData?: boolean;
    strategyKey?: string;
    backtestSettings?: BacktestSettings;
    capitalSettings?: Partial<CapitalSettings>;
}

export interface PolymarketFilterProjection {
    originalTrades: number;
    filteredTrades: number;
    removedPercent: number;
    filteredWinRate: number;
    bestBaselineWinRate: number;
    baselineDelta: number;
}
