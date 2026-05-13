import type { Time } from "lightweight-charts";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { OHLCVData, Trade } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";

export const SECOND_MARKET_DB_RELATIVE_PATH = "price-data/1second-chart/second-market-data.sqlite";

export const SECOND_MARKET_SYMBOLS = ["BTCUSDT", "XRPUSDT"] as const;
export type SecondMarketSymbol = typeof SECOND_MARKET_SYMBOLS[number];

export const SECOND_MARKET_SOURCE_NAMES = [
    "binance_1s",
    "polymarket_clob_1s",
    "polymarket_reference_1s",
    "polymarket_gamma",
] as const;
export type SecondMarketSourceName = typeof SECOND_MARKET_SOURCE_NAMES[number];

export const SECOND_MARKET_ALIGNMENT_MODES = ["strict", "causal_relaxed"] as const;
export type SecondMarketAlignmentMode = typeof SECOND_MARKET_ALIGNMENT_MODES[number];

export type SecondMarketReferenceSource = "crypto_prices" | "crypto_prices_chainlink";
export type SecondMarketFillSource = "bid_ask" | "mid" | "last";
export type SecondMarketSide = "yes" | "no";
export type SecondMarketOrderSide = "buy" | "sell";

export interface Binance1sCandleRow {
    symbol: SecondMarketSymbol;
    market_type: "spot" | "futures";
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trade_count: number | null;
    source: string;
    updated_at: number;
}

export interface PolymarketClob1sQuoteRow {
    series_id: string;
    symbol: SecondMarketSymbol;
    outcome_interval: PolymarketOutcomeInterval;
    event_start_ts: number;
    event_end_ts: number;
    condition_id: string;
    market_slug: string;
    yes_token_id: string;
    no_token_id: string;
    sample_ts: number;
    yes_bid: number | null;
    yes_ask: number | null;
    yes_mid: number | null;
    yes_last: number | null;
    no_bid: number | null;
    no_ask: number | null;
    no_mid: number | null;
    no_last: number | null;
    source: string;
    source_ts_ms: number | null;
    quote_age_ms: number | null;
    quality_flags: string;
    updated_at: number;
}

export interface PolymarketReference1sPriceRow {
    symbol: SecondMarketSymbol;
    reference_source: SecondMarketReferenceSource;
    source_symbol: string;
    ts: number;
    source_ts_ms: number;
    received_ts_ms: number | null;
    reference_price: number;
    full_accuracy_value: string;
    is_carried_forward: 0 | 1;
    quality_flags: string;
    updated_at: number;
}

export interface PolymarketGammaSnapshotRow {
    series_id: string;
    symbol: SecondMarketSymbol;
    outcome_interval: PolymarketOutcomeInterval;
    market_id: string;
    condition_id: string;
    market_slug: string;
    event_start_ts: number;
    event_end_ts: number;
    snapshot_ts: number;
    gamma_yes_price: number | null;
    gamma_no_price: number | null;
    last_trade_price: number | null;
    liquidity: number | null;
    volume: number | null;
    open_interest: number | null;
    active: 0 | 1;
    closed: 0 | 1;
    remote_updated_at: number | null;
    raw_json_hash: string;
    raw_json: string | null;
    updated_at: number;
}

export interface SecondDataSyncStateRow {
    source: SecondMarketSourceName | string;
    symbol: SecondMarketSymbol;
    series_id: string;
    cursor_ts: number | null;
    cursor_id: string;
    status: string;
    updated_at: number;
}

export interface SecondDataQualityRunRow {
    id: string;
    symbol: SecondMarketSymbol;
    start_ts: number;
    end_ts: number;
    binance_seconds: number;
    clob_quote_seconds: number;
    reference_price_seconds: number;
    gamma_snapshot_count: number;
    binance_gap_count: number;
    clob_gap_count: number;
    reference_gap_count: number;
    exact_quote_coverage_pct: number;
    max_quote_age_sec: number | null;
    max_reference_age_sec: number | null;
    created_at: number;
}

export interface AlignedClobQuote {
    candleTime: Time;
    targetTs: number;
    quote: PolymarketClob1sQuoteRow | null;
    quoteTs: number | null;
    quoteAgeSec: number | null;
    hasExactClobQuote: boolean;
    qualityFlags: string[];
}

export interface AlignedReferencePrice {
    candleTime: Time;
    targetTs: number;
    reference: PolymarketReference1sPriceRow | null;
    referenceTs: number | null;
    referenceAgeSec: number | null;
    hasReferencePrice: boolean;
    qualityFlags: string[];
}

export interface AlignedGammaSnapshot {
    candleTime: Time;
    targetTs: number;
    gamma: PolymarketGammaSnapshotRow | null;
    snapshotTs: number | null;
    gammaAgeSec: number | null;
    hasGammaSnapshot: boolean;
    qualityFlags: string[];
}

export interface SecondMarketWindow {
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    candles: OHLCVData[];
    clobQuotes: PolymarketClob1sQuoteRow[];
    referencePrices: PolymarketReference1sPriceRow[];
    gammaSnapshots: PolymarketGammaSnapshotRow[];
}

export interface SecondMarketPolymarketEvent {
    seriesId: string;
    symbol: SecondMarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    eventSlug: string;
    marketId: string;
    conditionId: string;
    marketSlug: string;
    eventStartTs: number;
    eventEndTs: number;
    yesTokenId: string;
    noTokenId: string;
}

export interface SecondMarketTradeResult {
    trade: Trade;
    outcome: PolymarketOutcomeRow | null;
    side: SecondMarketSide | null;
    entryPrice: number | null;
    entryQuoteTs: number | null;
    exitPrice: number | null;
    exitQuoteTs: number | null;
    exitSource: "signal" | "resolution" | "duplicate" | "no_event" | "missing";
    pnl: number | null;
    isProfitable: boolean | null;
}

export interface SecondMarketBacktestSummary {
    evaluationMode: "second_clob";
    scoredTrades: number;
    duplicateTradesIgnored: number;
    missingOutcomeTrades: number;
    missingQuoteTrades: number;
    signalExitedTrades: number;
    resolvedTrades: number;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    expectancy: number;
    avgEntryPrice: number | null;
    avgExitPrice: number | null;
    exactQuoteCoveragePct: number;
}
