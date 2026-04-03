import type { CapitalSettings } from "./backtest";
import type { BacktestSettings } from "./strategies";
import type {
    AnalysisFilterFinderResult,
    AnalysisFinderCandidate,
    ComboFilterEntry,
    ComboFilterResult,
    FeatureAnalysis,
} from "../strategies/backtest/trade-analyzer";

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
    outcomeRowsLoaded: number;
    scoredTrades: number;
    missingOutcomeTrades: number;
    unscoredTrades?: number;
    entryOffset?: number;
    duplicateTradesIgnored?: number;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
}

export interface PolymarketEvalResult {
    evaluatedEvents: number;
    predictionsTaken: number;
    scoredPredictions: number;
    pricedPredictions?: number;
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

export type PolymarketFeatureAnalysis = FeatureAnalysis;

export type PolymarketComboFilterEntry = ComboFilterEntry;

export type PolymarketComboFilterResult = ComboFilterResult;

export type PolymarketFinderCandidate = AnalysisFinderCandidate;

export type PolymarketFilterFinderResult = AnalysisFilterFinderResult;

export interface PolymarketFilterSampleCounts {
    scoredTrades: number;
    pricedTrades: number;
}

/** Full filter suggestions for Polymarket: single-feature + combo finder */
export interface PolymarketFilterSuggestions {
    featureAnalyses: PolymarketFeatureAnalysis[];
    finderResult: PolymarketFilterFinderResult;
    baselineWinRate: number;
    baselineExpectancy: number;
    sampleCounts: PolymarketFilterSampleCounts;
}
