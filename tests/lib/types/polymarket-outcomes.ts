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
}

export interface PolymarketEvalResult {
    evaluatedEvents: number;
    predictionsTaken: number;
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
    missingOutcomeRows: number;
    ignoredSignals: number;
    rows: PolymarketEvalRow[];
}

export interface PolymarketEvalOptions {
    executionMode?: 'next_open';
    tradeDirection?: 'long' | 'short' | 'both';
    usePreparedData?: boolean;
    strategyKey?: string;
}
