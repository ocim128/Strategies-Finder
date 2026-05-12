import type { CapitalSettings, TradeSizingMode } from "./backtest";
import type { BacktestSettings } from "./strategies";
import type { PolymarketEntrySelectionMode } from "../polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type {
    PolymarketLimitEntryPriceMode,
    PolymarketLimitExitPriceMode,
    PolymarketLimitExitStatus,
} from "../polymarket-post-signal-limit-entry";

export type PolymarketMarketEntrySource = "quote" | "limit";
export type PolymarketMarketEntryStatus =
    | "filled"
    | "not_touched"
    | "last_minute_only"
    | "missing_price_points"
    | "invalid_window"
    | "duplicate";

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
    /** Entry offset minute within the selected Polymarket event session. */
    entryOffset?: number;
}

export interface TradePolymarketOutcome {
    eventStartTs: number;
    eventEndTs: number;
    eventSlug: string;
    marketSlug: string;
    prediction: 'yes' | 'no';
    actualOutcomeUp: 0 | 1;
    isWin: boolean | null;
    /** Raw YES checkpoint price for the selected entry offset. */
    marketYesPrice?: number | null;
    /** Raw NO checkpoint price for the selected entry offset. */
    marketNoPrice?: number | null;
    /** Entry probability paid for this trade (YES for longs, NO for shorts). */
    marketEntryPrice?: number | null;
    marketEntrySource?: PolymarketMarketEntrySource;
    marketEntryStatus?: PolymarketMarketEntryStatus;
    marketEntryFillTs?: number | null;
    marketEntryLimitPrice?: number | null;
    marketEntryImprovement?: number | null;
    /** Entry offset minute within the selected Polymarket event session. */
    entryOffset?: number;
    /** Which evaluation mode produced this outcome annotation */
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    /** Whether the Polymarket trade was profitable (signal-exit aware, not binary outcome). Null means neutral or unscored. */
    isProfitable?: boolean | null;
    /** Exit price from the Polymarket contract */
    marketExitPrice?: number | null;
    /** Exit timestamp for the Polymarket leg */
    marketExitTs?: number | null;
    /** How the Polymarket leg exited: target (limit target), signal (same-event), resolution (final outcome), duplicate (same-event already scored), filtered (excluded by resolve-hold minute selection), no_event (no matching Polymarket event), or missing (price data unavailable) */
    marketExitSource?: "target" | "signal" | "resolution" | "duplicate" | "filtered" | "no_event" | "missing";
    marketExitTargetPrice?: number | null;
    marketExitStatus?: PolymarketLimitExitStatus;
    /** PnL for the Polymarket leg: marketExitPrice - marketEntryPrice */
    marketPnl?: number | null;
    /** Polymarket bankroll stake in dollars, only for non-fixed Alternative Sizing runs. */
    sizedStake?: number;
    /** Polymarket shares bought with sizedStake. */
    sizedShares?: number;
    /** Sized Polymarket dollar PnL for this trade. */
    sizedPnl?: number;
    /** Sized Polymarket return on staked dollars, expressed as percent. */
    sizedPnlPercent?: number;
    /** Polymarket bankroll before this sized trade. */
    sizedEquityBefore?: number;
    /** Polymarket bankroll after this sized trade. */
    sizedEquityAfter?: number;
    /** Sizing mode used for this Polymarket stake. */
    sizedSizingMode?: TradeSizingMode;
    /** Whether the intended stake was capped to available Polymarket bankroll. */
    sizedStakeCapped?: boolean;
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
    outcomeInterval?: PolymarketOutcomeInterval;
    outcomeRowsLoaded: number;
    scoredTrades: number;
    missingOutcomeTrades: number;
    unscoredTrades?: number;
    entrySelectionMode?: PolymarketEntrySelectionMode;
    entryOffset?: number;
    duplicateTradesIgnored?: number;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
    evaluationMode?: "resolve_hold" | "signal_exit_same_event";
    profitableTrades?: number;
    losingTrades?: number;
    neutralTrades?: number;
    signalExitedTrades?: number;
    targetExitedTrades?: number;
    resolvedTrades?: number;
    missingPriceTrades?: number;
    netPnl?: number;
    grossProfit?: number;
    grossLoss?: number;
    profitFactor?: number;
    expectancy?: number;
    avgEntryPrice?: number;
    avgExitPrice?: number;
    limitEntryEnabled?: boolean;
    limitEntryMode?: PolymarketLimitEntryPriceMode;
    limitEntryPriceCents?: number;
    limitEntryOffsetCents?: number;
    limitEntryAttempts?: number;
    limitEntryFilledTrades?: number;
    limitEntryMissedTrades?: number;
    limitEntryNotTouchedTrades?: number;
    limitEntryLastMinuteOnlyTrades?: number;
    limitEntryMissingPriceTrades?: number;
    limitEntryInvalidWindowTrades?: number;
    limitEntryFillRate?: number;
    avgLimitEntryWaitSec?: number;
    avgLimitEntryImprovement?: number;
    limitExitEnabled?: boolean;
    limitExitMode?: PolymarketLimitExitPriceMode;
    limitExitPriceCents?: number;
    limitExitOffsetCents?: number;
    limitExitFilledTrades?: number;
    limitExitFallbackTrades?: number;
    limitExitUnreachableTrades?: number;
    sizedSizingMode?: TradeSizingMode;
    sizedInitialCapital?: number;
    sizedFinalEquity?: number;
    sizedNetProfit?: number;
    sizedNetProfitPercent?: number;
    sizedGrossProfit?: number;
    sizedGrossLoss?: number;
    sizedProfitFactor?: number;
    sizedExpectancy?: number;
    sizedMaxDrawdown?: number;
    sizedMaxDrawdownPercent?: number;
    sizedTrades?: number;
    sizedSkippedTrades?: number;
    sizedNoCapitalTrades?: number;
    sizedCappedTrades?: number;
    sizedTotalStaked?: number;
    sizedAvgStake?: number;
    sizedMaxStake?: number;
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
    targetExitedTrades?: number;
    resolvedTrades?: number;
    missingPriceTrades?: number;
    limitEntryEnabled?: boolean;
    limitEntryMode?: PolymarketLimitEntryPriceMode;
    limitEntryPriceCents?: number;
    limitEntryOffsetCents?: number;
    limitEntryAttempts?: number;
    limitEntryFilledTrades?: number;
    limitEntryMissedTrades?: number;
    limitEntryNotTouchedTrades?: number;
    limitEntryLastMinuteOnlyTrades?: number;
    limitEntryMissingPriceTrades?: number;
    limitEntryInvalidWindowTrades?: number;
    limitEntryFillRate?: number;
    avgLimitEntryWaitSec?: number;
    avgLimitEntryImprovement?: number;
    limitExitEnabled?: boolean;
    limitExitMode?: PolymarketLimitExitPriceMode;
    limitExitPriceCents?: number;
    limitExitOffsetCents?: number;
    limitExitFilledTrades?: number;
    limitExitFallbackTrades?: number;
    limitExitUnreachableTrades?: number;
    netPnl?: number;
    avgExitPrice?: number;
    sizedNetProfit?: number;
    sizedNetProfitPercent?: number;
    sizedTrades?: number;
    sizedSkippedTrades?: number;
    sizedSizingMode?: TradeSizingMode;
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
